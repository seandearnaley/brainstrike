import type { DelegatedConversationBaseline } from '@brainstrike/assistant-contract';
import {
  assistantChildSignalContentsSchema,
  type DelegatedToolActionIdentity,
  isDelegatedToolActionIdentity,
  readAssistantChildSignalContents,
} from '@brainstrike/assistant-contract';
import { z } from 'zod';
import type { ConversationStreamChunk, StreamChunkDelegatedConversation } from '../types';
import { readChildContinuationUserMessage } from './child-continuation-user-message';
import type { DelegatedRunIdentity } from './delegated-run-publication';
import { readDelegatedStepUsage } from './delegated-step-usage';
import type { SubagentChildUsageReport } from './subagent-delegation';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';
import { resolveDelegationPersona } from './tool-lifecycle-processors';

type DelegatedPause = Extract<
  ConversationStreamChunk,
  { type: 'tool-approval-required' | 'tool-suspend-required' }
>;

interface ChildStreamState<State> {
  baseline?: DelegatedConversationBaseline | undefined;
  finished: boolean;
  readonly identity: DelegatedRunIdentity;
  messageId: string;
  readonly state: State;
  readonly threadId: string;
  readonly toolNames: Map<string, string>;
}

interface DelegatedStreamProjectionOptions<State> {
  readonly authorize:
    | ((identity: DelegatedRunIdentity) => Promise<{
        readonly threadId: string;
        readonly messageId?: string;
        readonly baseline?: DelegatedConversationBaseline | undefined;
      }>)
    | undefined;
  readonly createState: (personaId: string, threadId: string) => State;
  readonly mapPart: (
    part: unknown,
    state: State,
    toolNames: Map<string, string>
  ) => Promise<{ readonly chunks: readonly ConversationStreamChunk[]; readonly finished: boolean }>;
  readonly onUsage?: ((usage: SubagentChildUsageReport) => void) | undefined;
  readonly personas: ReadonlyMap<string, string>;
}

function requireIdentity(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Delegated stream requires observed native identity.');
  }
  return value;
}

function assertChildIdentity<State>(
  child: ChildStreamState<State> | undefined,
  identity: DelegatedRunIdentity
): void {
  if (
    child &&
    (child.identity.childRuntimeRunId !== identity.childRuntimeRunId ||
      child.identity.personaId !== identity.personaId)
  ) {
    throw new Error('Delegated stream changed its native invocation identity.');
  }
}

function projectHumanInput<State>(
  part: unknown,
  children: ReadonlyMap<string, ChildStreamState<State>>
): StreamChunkDelegatedConversation[] {
  const data = readMastraStreamPartValue(part, 'data');
  if (readChildContinuationUserMessage(data)) {
    return [];
  }
  const input = z
    .object({
      contents: assistantChildSignalContentsSchema,
      createdAt: z.iso.datetime(),
      id: z.string().min(1),
      metadata: z.object({
        brainstrikeDelegatedInput: z.object({
          childRuntimeRunId: z.string(),
          parentRuntimeRunId: z.string(),
          parentToolCallId: z.string(),
          personaId: z.string(),
        }),
      }),
    })
    .parse(readMastraStreamPartValue(part, 'data'));
  const identity = input.metadata.brainstrikeDelegatedInput;
  const child = children.get(
    JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId])
  );
  if (
    !child ||
    child.finished ||
    child.identity.childRuntimeRunId !== identity.childRuntimeRunId ||
    child.identity.personaId !== identity.personaId
  ) {
    throw new Error('Human input has no matching active delegated stream owner.');
  }
  return [
    {
      chunk: {
        createdAt: input.createdAt,
        id: input.id,
        ...readAssistantChildSignalContents(input.contents),
        type: 'child-user-message',
      },
      identity: child.identity,
      messageId: child.messageId,
      type: 'delegated-conversation-chunk',
    },
  ];
}

function projectPublishedUsage<State>(
  usage: NonNullable<ReturnType<typeof readDelegatedStepUsage>>,
  children: ReadonlyMap<string, ChildStreamState<State>>,
  onUsage: DelegatedStreamProjectionOptions<State>['onUsage']
): void {
  const owners = [...children.values()].filter(
    (child) => child.threadId === usage.threadId && !child.finished
  );
  const owner = owners[0];
  if (owners.length !== 1 || !owner || !onUsage) {
    throw new Error('Delegated usage has no unique published native child owner.');
  }
  onUsage({
    delegation: {
      parentRuntimeRunId: owner.identity.parentRuntimeRunId,
      parentToolCallId: owner.identity.parentToolCallId,
      resourceId: usage.resourceId,
      threadId: usage.threadId,
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    personaId: owner.identity.personaId,
  });
}

/**
 * The delegation a `tool-output` part belongs to and the nested child part it
 * carries, or undefined when the part is not a child stream. Mastra answers a
 * REFUSED delegation through the parent's own writer, under the parent's run
 * id: `[Delegation Rejected] …` text and nothing else. No child ran, so there
 * is no native identity to bind (BST-1751); the tool result carries the
 * refusal to the model and the lifecycle mapper records the outcome. A real
 * child streams under its own run id.
 */
function resolveChildDelegation(
  part: unknown,
  toolNames: Map<string, string>,
  personas: ReadonlyMap<string, string>
):
  | { delegation: NonNullable<ReturnType<typeof resolveDelegationPersona>>; nested: unknown }
  | undefined {
  const delegation = resolveDelegationPersona(part, toolNames, personas);
  if (!delegation) {
    return;
  }
  const nested = readMastraStreamPartValue(part, 'output');
  if (readMastraStreamPartString(nested, 'runId') === readMastraStreamPartString(part, 'runId')) {
    return;
  }
  return { delegation, nested };
}

/** One projection per attempt: native invocation identity owns independent mapper state. */
export function createDelegatedStreamProjection<State>(
  options: DelegatedStreamProjectionOptions<State>
):
  | {
      decorate: (chunk: ConversationStreamChunk) => ConversationStreamChunk;
      preparePart: (part: unknown) => unknown;
      finalize: (
        finish: (state: State) => readonly ConversationStreamChunk[]
      ) => StreamChunkDelegatedConversation[];
      project: (
        part: unknown,
        toolNames: Map<string, string>
      ) => Promise<StreamChunkDelegatedConversation[]>;
    }
  | undefined {
  const authorize = options.authorize;
  if (!authorize) {
    return;
  }
  const children = new Map<string, ChildStreamState<State>>();
  const pendingActions = new Map<
    string,
    { delegation: DelegatedToolActionIdentity; pause: DelegatedPause; registeredToolName: string }
  >();
  const actionKey = (runId: string, toolCallId: string) => JSON.stringify([runId, toolCallId]);
  const decorate = (
    chunk: ConversationStreamChunk,
    path: readonly DelegatedRunIdentity[] = [],
    registeredToolName?: string
  ): ConversationStreamChunk => {
    if (chunk.type !== 'tool-approval-required' && chunk.type !== 'tool-suspend-required') {
      return chunk;
    }
    const forwarded = pendingActions.get(actionKey(chunk.runId, chunk.toolCallId));
    if (forwarded) {
      return { ...chunk, delegation: forwarded.delegation };
    }
    if (path.length === 0) {
      return chunk;
    }
    const delegation = { path, toolCallId: chunk.toolCallId };
    if (!isDelegatedToolActionIdentity(delegation)) {
      throw new Error('Delegated tool pause has invalid native ancestry.');
    }
    for (const edge of path) {
      pendingActions.set(actionKey(edge.parentRuntimeRunId, edge.parentToolCallId), {
        delegation,
        pause: chunk,
        registeredToolName: requireIdentity(registeredToolName),
      });
    }
    return { ...chunk, delegation };
  };

  // Native parent pauses name the delegation tool, while their interactive
  // payload belongs to the leaf. Restore that observed leaf before the common
  // mapper classifies UI support and builds approval metadata. Resume transport
  // coordinates remain those of the parent wrapper.
  const preparePart = (part: unknown): unknown => {
    const type = readMastraStreamPartString(part, 'type');
    if (type !== 'tool-call-approval' && type !== 'tool-call-suspended') {
      return part;
    }
    const runId = readMastraStreamPartString(part, 'runId');
    const toolCallId = readMastraStreamPartString(part, 'toolCallId');
    if (!(runId && toolCallId)) {
      return part;
    }
    const forwarded = pendingActions.get(actionKey(runId, toolCallId));
    if (!forwarded) {
      return part;
    }
    const pause = forwarded.pause;
    if ((type === 'tool-call-approval') !== (pause.type === 'tool-approval-required')) {
      throw new Error('Forwarded delegated pause changed its decision kind.');
    }
    return {
      payload: {
        resumeSchema: pause.resumeSchema,
        toolCallId,
        toolName: forwarded.registeredToolName,
        ...(pause.type === 'tool-approval-required'
          ? { args: pause.args }
          : { suspendPayload: pause.suspendPayload }),
      },
      runId,
      type,
    };
  };

  const project = async (
    part: unknown,
    toolNames: Map<string, string>,
    ancestors: readonly DelegatedRunIdentity[] = []
  ): Promise<StreamChunkDelegatedConversation[]> => {
    const usage = readDelegatedStepUsage(part);
    if (usage) {
      projectPublishedUsage(usage, children, options.onUsage);
      return [];
    }
    if (readMastraStreamPartString(part, 'type') === 'data-user-message') {
      return projectHumanInput(part, children);
    }
    if (readMastraStreamPartString(part, 'type') !== 'tool-output') {
      return [];
    }
    const resolved = resolveChildDelegation(part, toolNames, options.personas);
    if (!resolved) {
      return [];
    }
    const { delegation, nested } = resolved;
    const identity: DelegatedRunIdentity = {
      childRuntimeRunId: requireIdentity(readMastraStreamPartString(nested, 'runId')),
      parentRuntimeRunId: requireIdentity(readMastraStreamPartString(part, 'runId')),
      parentToolCallId: requireIdentity(delegation.parentToolCallId),
      personaId: delegation.personaId,
    };
    const key = JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);
    let child = children.get(key);
    assertChildIdentity(child, identity);
    if (!child) {
      const binding = await authorize(identity);
      child = {
        ...(binding.baseline ? { baseline: binding.baseline } : {}),
        finished: false,
        identity,
        // Snapshot resume can forward a descendant before replaying this
        // child's message id. Only the authorized invocation's saved id is valid.
        messageId: requireIdentity(
          readMastraStreamPartString(nested, 'messageId') ?? binding.messageId
        ),
        state: options.createState(identity.personaId, requireIdentity(binding.threadId)),
        threadId: requireIdentity(binding.threadId),
        toolNames: new Map(),
      };
      children.set(key, child);
    }
    if (child.finished) {
      return [];
    }
    const messageId = readMastraStreamPartString(nested, 'messageId');
    if (messageId !== undefined) {
      child.messageId = requireIdentity(messageId);
    }
    const path = [...ancestors, child.identity];
    const descendants = await project(nested, child.toolNames, path);
    const { chunks, finished } = await options.mapPart(
      preparePart(nested),
      child.state,
      child.toolNames
    );
    child.finished = finished;
    const projected = chunks.map((chunk, index): StreamChunkDelegatedConversation => {
      const partId = readMastraStreamPartString(nested, 'id');
      return {
        ...(index === 0 && child.baseline ? { baseline: child.baseline } : {}),
        identity: child.identity,
        messageId: child.messageId,
        type: 'delegated-conversation-chunk',
        ...(partId ? { partId } : {}),
        chunk: decorate(
          chunk,
          path,
          readMastraStreamPartString(nested, 'toolName') ??
            readMastraStreamPartString(nested, 'name') ??
            child.toolNames.get(readMastraStreamPartString(nested, 'toolCallId') ?? '')
        ),
      };
    });
    if (projected.length > 0) {
      child.baseline = undefined;
    }
    return [...descendants, ...projected];
  };

  return {
    decorate,
    finalize: (finish) => {
      const result: StreamChunkDelegatedConversation[] = [];
      // Settle descendants before their parent, retaining each message's identity.
      for (const child of [...children.values()].reverse()) {
        if (child.finished) {
          continue;
        }
        for (const chunk of finish(child.state)) {
          result.push({
            ...(child.baseline ? { baseline: child.baseline } : {}),
            chunk,
            identity: child.identity,
            messageId: child.messageId,
            type: 'delegated-conversation-chunk',
          });
          child.baseline = undefined;
        }
        child.finished = true;
      }
      return result;
    },
    preparePart,
    project,
  };
}
