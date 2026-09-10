import type { DelegationStartContext } from '@mastra/core/agent';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor } from '@mastra/core/processors';
import type { DelegatedRunIdentity } from './delegated-run-publication';

/** Observed native identities; the host separately supplies and verifies root ownership. */
export interface DelegatedConversationIdentity {
  readonly childResourceId: string;
  readonly childThreadId: string;
  readonly configuration: unknown;
  readonly parentResourceId: string;
  readonly parentRuntimeRunId: string;
  readonly parentThreadId: string;
  readonly parentToolCallId: string;
  readonly personaId: string;
}

export interface DelegatedConversationBinding {
  /** Host capability required for durable invocation publication/resume authorization. */
  readonly bindRun?: (identity: DelegatedRunIdentity) => Promise<void>;
  readonly inputProcessor: InputProcessor;
  prepare(context: DelegationStartContext, configuration: unknown): void;
}

type ParentIdentity = Omit<DelegatedConversationIdentity, 'childResourceId' | 'childThreadId'>;

function requireIdentity(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Delegated conversation requires an observed native identity.');
  }
  return value;
}

/**
 * Correlate concurrent native calls without copying RuntimeData into RequestContext.
 * This weak map lives only for the runtime. Durable snapshot resume skips processInput:
 * the host must authorize persisted identity before forwarding resumed events.
 */
export function createDelegatedConversationBinding(
  persist: (identity: DelegatedConversationIdentity) => Promise<void>
): DelegatedConversationBinding {
  const scopes = new WeakMap<DelegationStartContext['requestContext'], ParentIdentity>();
  return {
    inputProcessor: {
      id: 'brainstrike-delegated-conversation-binding',
      processInput: async ({ messages, requestContext }) => {
        const parent = requestContext ? scopes.get(requestContext) : undefined;
        if (!parent) {
          throw new Error('Delegated conversation has no trusted parent binding.');
        }
        const child = parseMemoryRequestContext(requestContext);
        await persist({
          ...parent,
          childResourceId: requireIdentity(child?.resourceId),
          childThreadId: requireIdentity(child?.thread?.id),
        });
        return messages;
      },
    },
    prepare(context, configuration) {
      if (scopes.has(context.requestContext)) {
        throw new Error('Delegated conversation parent binding already exists.');
      }
      scopes.set(context.requestContext, {
        configuration: structuredClone(configuration),
        parentResourceId: requireIdentity(context.resourceId),
        parentRuntimeRunId: requireIdentity(context.runId),
        parentThreadId: requireIdentity(context.threadId),
        parentToolCallId: requireIdentity(context.toolCallId),
        personaId: requireIdentity(context.primitiveId),
      });
    },
  };
}
