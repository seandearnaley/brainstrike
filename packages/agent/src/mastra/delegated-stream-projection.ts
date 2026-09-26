import type {
  DelegatedConversationBaseline,
  DelegationBudgetCap,
} from '@brainstrike/assistant-contract';
import {
  assistantChildSignalContentsSchema,
  createAssistantRunEvent,
  type DelegatedToolActionIdentity,
  isDelegatedToolActionIdentity,
  readAssistantChildSignalContents,
} from '@brainstrike/assistant-contract';
import { z } from 'zod';
import type { ConversationStreamChunk, StreamChunkDelegatedConversation } from '../types';
import { readChildContinuationUserMessage } from './child-continuation-user-message';
import type { DelegatedRunIdentity } from './delegated-run-publication';
import { readDelegatedStepUsage } from './delegated-step-usage';
import {
  type DelegatedSynthesisPart,
  readDelegatedSynthesisPart,
} from './delegated-synthesis-outcomes';
import { MCP_PROGRESS_STREAM_PART_TYPE } from './mcp-runtime-client';
import { SHELL_OUTPUT_STREAM_PART_TYPE } from './shell-output-stream';
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
  /**
   * The child finished on a PAUSE (approval / typed suspension), not a
   * completion: a decision delivered into the running leg resumes it under
   * the same invocation, and its continuation re-enters this projection.
   */
  parked: boolean;
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
  readonly createState: (
    personaId: string,
    threadId: string,
    identity: DelegatedRunIdentity
  ) => State;
  readonly isActiveToolCall: (state: State, toolCallId: string) => boolean;
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

function assertObservedCustomMessageIdentity(part: unknown, observedMessageId: string): void {
  const type = readMastraStreamPartString(part, 'type');
  if (type !== SHELL_OUTPUT_STREAM_PART_TYPE && type !== MCP_PROGRESS_STREAM_PART_TYPE) {
    return;
  }
  if (readMastraStreamPartValue(part, 'runId') !== undefined) {
    return;
  }
  const rawMessageId = readMastraStreamPartValue(part, 'messageId');
  if (
    rawMessageId !== undefined &&
    readMastraStreamPartString(part, 'messageId') !== observedMessageId
  ) {
    throw new Error('Delegated tool progress changed its observed message identity.');
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

/**
 * A finished child accepts no more parts — unless it finished on a PAUSE: a
 * parked child resumed in-process (a live decision) continues the same native
 * invocation, so its stream reopens rather than being dropped as late parts.
 */
function reopenIfParked<State>(child: ChildStreamState<State>): boolean {
  if (!child.finished) {
    return true;
  }
  if (!child.parked) {
    return false;
  }
  child.finished = false;
  child.parked = false;
  return true;
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
    throw new Error(
      `Delegated usage has no unique published native child owner (usage thread ${usage.threadId}; active children ${JSON.stringify(
        [...children.values()]
          .filter((child) => !child.finished)
          .map((child) => [child.identity.parentToolCallId, child.threadId])
      )}).`
    );
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

const SYNTHESIS_CAP_NOUNS = {
  'child-output': 'output token',
  steps: 'step',
  'tree-output': 'shared output token',
} as const satisfies Record<DelegationBudgetCap, string>;

/**
 * The budget processor's reserved-synthesis outcome becomes the owner child's
 * persisted `delegation.budget.exhausted` breadcrumb (status `info`, no pair):
 * the cap that forced the summary, `used` of `limit` in that cap's unit, and
 * whether the model then cut the summary. Like usage, the part is raw on the
 * parent stream, so its owner is the ONE published unfinished child on its
 * native thread; none or several is a contract break, never a dropped event.
 */
function projectSynthesisOutcome<State>(
  outcome: DelegatedSynthesisPart,
  children: ReadonlyMap<string, ChildStreamState<State>>
): StreamChunkDelegatedConversation[] {
  const owners = [...children.values()].filter(
    (child) => child.threadId === outcome.threadId && !child.finished
  );
  const owner = owners[0];
  if (owners.length !== 1 || !owner) {
    throw new Error(
      `Delegated synthesis outcome has no unique published native child owner (thread ${outcome.threadId}).`
    );
  }
  const event = createAssistantRunEvent({
    kind: 'delegation.budget.exhausted',
    label: `Subagent ${SYNTHESIS_CAP_NOUNS[outcome.cap]} budget exhausted (${outcome.used} of ${outcome.limit}); summary ${outcome.truncated ? 'reserved and truncated' : 'reserved'}`,
    metadata: {
      cap: outcome.cap,
      limit: outcome.limit,
      parentToolCallId: owner.identity.parentToolCallId,
      personaId: owner.identity.personaId,
      reservedOutputTokens: outcome.reservedOutputTokens,
      // Always true here: this event exists because the reserved summary step ran.
      synthesisForced: true,
      truncated: outcome.truncated,
      used: outcome.used,
      ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
    },
    status: 'info',
  });
  return [
    {
      chunk: { event, type: 'run-event' },
      identity: owner.identity,
      messageId: owner.messageId,
      type: 'delegated-conversation-chunk',
    },
  ];
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
  const childRunId = readMastraStreamPartString(nested, 'runId');
  // A missing child run id is a contract break the identity check below
  // reports loudly; only a run id equal to the parent's marks a refusal.
  if (childRunId !== undefined && childRunId === readMastraStreamPartString(part, 'runId')) {
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
      seedResumedToolCall: (resume: {
        readonly path: readonly DelegatedRunIdentity[];
        readonly toolCall: {
          readonly args: unknown;
          readonly registeredToolName: string;
          readonly toolCallId: string;
        };
      }) => Promise<StreamChunkDelegatedConversation[]>;
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

  /** The child stream for a delegation envelope, authorized once per invocation. */
  const admitChild = async (
    identity: DelegatedRunIdentity,
    nested: unknown
  ): Promise<ChildStreamState<State>> => {
    const key = JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);
    const existing = children.get(key);
    assertChildIdentity(existing, identity);
    if (existing) {
      return existing;
    }
    const binding = await authorize(identity);
    const child: ChildStreamState<State> = {
      ...(binding.baseline ? { baseline: binding.baseline } : {}),
      finished: false,
      identity,
      // Snapshot resume can forward a descendant before replaying this
      // child's message id. Only the authorized invocation's saved id is valid.
      messageId: requireIdentity(
        readMastraStreamPartString(nested, 'messageId') ?? binding.messageId
      ),
      parked: false,
      state: options.createState(identity.personaId, requireIdentity(binding.threadId), identity),
      threadId: requireIdentity(binding.threadId),
      toolNames: new Map(),
    };
    children.set(key, child);
    return child;
  };

  const resolveChild = async (
    parentRuntimeRunId: string,
    parentToolCallId: string,
    personaId: string,
    nested: unknown
  ): Promise<ChildStreamState<State> | undefined> => {
    const childRuntimeRunId = readMastraStreamPartString(nested, 'runId');
    const nestedType = readMastraStreamPartString(nested, 'type');
    const isToolCustomPart =
      nestedType === SHELL_OUTPUT_STREAM_PART_TYPE || nestedType === MCP_PROGRESS_STREAM_PART_TYPE;
    if (isToolCustomPart && readMastraStreamPartValue(nested, 'runId') === undefined) {
      // Mastra forwards writer.custom() verbatim, without a run id. A tool's
      // transient progress can use only the child invocation already authorized
      // for this exact parent call and the tool call already observed within it.
      const existing = children.get(JSON.stringify([parentRuntimeRunId, parentToolCallId]));
      const toolCallId = readMastraStreamPartString(nested, 'toolCallId');
      if (
        !existing ||
        (existing.finished && !existing.parked) ||
        existing.identity.personaId !== personaId ||
        !toolCallId ||
        !existing.toolNames.has(toolCallId) ||
        !options.isActiveToolCall(existing.state, toolCallId)
      ) {
        throw new Error('Delegated tool progress has no observed active native owner.');
      }
      if (!reopenIfParked(existing)) {
        throw new Error('Delegated tool progress has no observed active native owner.');
      }
      return existing;
    }
    const child = await admitChild(
      {
        childRuntimeRunId: requireIdentity(childRuntimeRunId),
        parentRuntimeRunId,
        parentToolCallId,
        personaId,
      },
      nested
    );
    return reopenIfParked(child) ? child : undefined;
  };

  const seedResumedToolCall = async (resume: {
    readonly path: readonly DelegatedRunIdentity[];
    readonly toolCall: {
      readonly args: unknown;
      readonly registeredToolName: string;
      readonly toolCallId: string;
    };
  }): Promise<StreamChunkDelegatedConversation[]> => {
    if (resume.path.length === 0) {
      throw new Error('Delegated resume requires its authorized native ancestry.');
    }
    let leaf: ChildStreamState<State> | undefined;
    for (const [index, identity] of resume.path.entries()) {
      leaf = await admitChild(identity, {});
      if (leaf.finished && !reopenIfParked(leaf)) {
        throw new Error('Delegated resume cannot reopen a completed native invocation.');
      }
      const next = resume.path[index + 1];
      if (next) {
        if (next.parentRuntimeRunId !== identity.childRuntimeRunId) {
          throw new Error('Delegated resume changed its native ancestry.');
        }
        leaf.toolNames.set(next.parentToolCallId, `agent-${next.personaId}`);
      }
    }
    if (!leaf) {
      throw new Error('Delegated resume requires its authorized native leaf.');
    }
    const { args, registeredToolName, toolCallId } = resume.toolCall;
    const { chunks, finished } = await options.mapPart(
      { args, toolCallId, toolName: registeredToolName, type: 'tool-call' },
      leaf.state,
      leaf.toolNames
    );
    leaf.finished = finished;
    const path = resume.path;
    const projected = chunks.map(
      (chunk, index): StreamChunkDelegatedConversation => ({
        ...(index === 0 && leaf.baseline ? { baseline: leaf.baseline } : {}),
        chunk: decorate(chunk, path, registeredToolName),
        identity: leaf.identity,
        messageId: leaf.messageId,
        type: 'delegated-conversation-chunk',
      })
    );
    if (projected.length > 0) {
      leaf.baseline = undefined;
    }
    return projected;
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
    const synthesis = readDelegatedSynthesisPart(part);
    if (synthesis) {
      return projectSynthesisOutcome(synthesis, children);
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
    const parentRuntimeRunId = requireIdentity(readMastraStreamPartString(part, 'runId'));
    const parentToolCallId = requireIdentity(delegation.parentToolCallId);
    const child = await resolveChild(
      parentRuntimeRunId,
      parentToolCallId,
      delegation.personaId,
      nested
    );
    if (!child) {
      return [];
    }
    assertObservedCustomMessageIdentity(nested, child.messageId);
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
    const nestedType = readMastraStreamPartString(nested, 'type');
    child.parked =
      finished && (nestedType === 'tool-call-approval' || nestedType === 'tool-call-suspended');
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
    seedResumedToolCall,
  };
}
