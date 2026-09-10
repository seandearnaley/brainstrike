import type { ConversationStreamChunk, StreamChunkDelegatedConversation } from '../types';
import type { DelegatedRunIdentity } from './delegated-run-publication';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';
import { resolveDelegationPersona } from './tool-lifecycle-processors';

interface ChildStreamState<State> {
  finished: boolean;
  readonly identity: DelegatedRunIdentity;
  messageId?: string;
  readonly state: State;
  readonly toolNames: Map<string, string>;
}

interface DelegatedStreamProjectionOptions<State> {
  readonly authorize: ((identity: DelegatedRunIdentity) => Promise<void>) | undefined;
  readonly createState: (personaId: string) => State;
  readonly mapPart: (
    part: unknown,
    state: State,
    toolNames: Map<string, string>
  ) => Promise<{ readonly chunks: readonly ConversationStreamChunk[]; readonly finished: boolean }>;
  readonly personas: ReadonlyMap<string, string>;
}

function requireIdentity(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Delegated stream requires observed native identity.');
  }
  return value;
}

/** One projection per attempt: native invocation identity owns independent mapper state. */
export function createDelegatedStreamProjection<State>(
  options: DelegatedStreamProjectionOptions<State>
):
  | {
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

  const project = async (
    part: unknown,
    toolNames: Map<string, string>
  ): Promise<StreamChunkDelegatedConversation[]> => {
    if (readMastraStreamPartString(part, 'type') !== 'tool-output') {
      return [];
    }
    const delegation = resolveDelegationPersona(part, toolNames, options.personas);
    if (!delegation) {
      return [];
    }
    const nested = readMastraStreamPartValue(part, 'output');
    const identity: DelegatedRunIdentity = {
      childRuntimeRunId: requireIdentity(readMastraStreamPartString(nested, 'runId')),
      parentRuntimeRunId: requireIdentity(readMastraStreamPartString(part, 'runId')),
      parentToolCallId: requireIdentity(delegation.parentToolCallId),
      personaId: delegation.personaId,
    };
    const key = JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);
    let child = children.get(key);
    if (
      child &&
      (child.identity.childRuntimeRunId !== identity.childRuntimeRunId ||
        child.identity.personaId !== identity.personaId)
    ) {
      throw new Error('Delegated stream changed its native invocation identity.');
    }
    if (!child) {
      await authorize(identity);
      child = {
        finished: false,
        identity,
        state: options.createState(identity.personaId),
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
    const descendants = await project(nested, child.toolNames);
    const { chunks, finished } = await options.mapPart(nested, child.state, child.toolNames);
    child.finished = finished;
    const projected = chunks.map((chunk): StreamChunkDelegatedConversation => {
      if (
        (chunk.type === 'text-delta' ||
          chunk.type === 'reasoning-delta' ||
          chunk.type === 'tool-event') &&
        !child.messageId
      ) {
        throw new Error('Delegated content has no observed native message identity.');
      }
      const partId = readMastraStreamPartString(nested, 'id');
      return {
        identity: child.identity,
        type: 'delegated-conversation-chunk',
        ...(child.messageId ? { messageId: child.messageId } : {}),
        ...(partId ? { partId } : {}),
        chunk,
      };
    });
    return [...descendants, ...projected];
  };

  return {
    finalize: (finish) => {
      const result: StreamChunkDelegatedConversation[] = [];
      // Settle descendants before their parent, retaining each message's identity.
      for (const child of [...children.values()].reverse()) {
        if (child.finished) {
          continue;
        }
        for (const chunk of finish(child.state)) {
          result.push({
            identity: child.identity,
            type: 'delegated-conversation-chunk',
            ...(child.messageId ? { messageId: child.messageId } : {}),
            chunk,
          });
        }
        child.finished = true;
      }
      return result;
    },
    project,
  };
}
