import type {
  DelegatedConversationBaseline,
  DelegatedOriginalToolCall,
  DelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import { type DelegationStartContext, MessageList } from '@mastra/core/agent';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor } from '@mastra/core/processors';
import type { ToolHooks } from '@mastra/core/tools';
import { readToolCallId, readToolExecutionThreadId } from '../tools/read-tool-call-id';
import type { DelegatedRunIdentity } from './delegated-run-publication';

/** Observed native identities; the host separately supplies and verifies root ownership. */
export interface DelegatedConversationIdentity {
  readonly childResourceId: string;
  readonly childThreadId: string;
  /** Structured-cloneable snapshot; the host validates a finite JSON object before storage. */
  readonly configuration: unknown;
  readonly originalToolCall?: DelegatedOriginalToolCall;
  readonly parentResourceId: string;
  readonly parentRuntimeRunId: string;
  readonly parentThreadId: string;
  readonly parentToolCallId: string;
  readonly personaId: string;
}

export interface DelegatedToolActionScope {
  readonly identity: DelegatedRunIdentity;
  readonly originalToolCall?: DelegatedOriginalToolCall;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface DelegatedConversationBinding {
  /** Host capability required for durable invocation publication/resume authorization. */
  readonly bindRun?: (identity: DelegatedRunIdentity) => Promise<{
    readonly threadId: string;
    readonly messageId?: string;
    readonly baseline?: DelegatedConversationBaseline;
  }>;
  /** Atomic admission after native snapshot validation, held through runtime disposal. */
  readonly claimToolAction?: (action: {
    readonly delegation?: DelegatedToolActionIdentity;
    readonly runId: string;
    readonly toolCallId: string;
  }) => Promise<void>;
  /** Releases only claims acquired by this binding; consumed leaf ids remain durable. */
  readonly finishToolActions?: () => Promise<void>;
  readonly hooks?: ToolHooks;
  readonly inputProcessor: InputProcessor;
  prepare(context: DelegationStartContext, configuration: unknown): void;
  /** Freeze child history after admission and before invoking native resume. */
  readonly prepareToolAction?: NonNullable<DelegatedConversationBinding['claimToolAction']>;
  /** Roll back this owner's claim only when native resume has not been invoked. */
  readonly releaseUnexecutedToolAction?: NonNullable<
    DelegatedConversationBinding['claimToolAction']
  >;
  /** Read-only authorization of a decision path against the original host-owned graph. */
  readonly resolveToolAction?: (action: {
    readonly delegation?: DelegatedToolActionIdentity;
    readonly runId: string;
    readonly toolCallId: string;
  }) => Promise<readonly DelegatedToolActionScope[]>;
}

type ParentIdentity = Omit<DelegatedConversationIdentity, 'childResourceId' | 'childThreadId'>;

function requireIdentity(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Delegated conversation requires an observed native identity.');
  }
  return value;
}

function readOriginalToolCall(
  input: DelegationStartContext['messages'],
  toolCallId: string,
  expectedToolName: string
): DelegatedOriginalToolCall | undefined {
  // The native before-tool hook carries the current model call in AI SDK
  // format. Normalize through Mastra's public adapter before reading it.
  const messages = new MessageList();
  messages.add(input, 'input');
  for (const message of messages.get.all.db().toReversed()) {
    for (const part of message.content.parts.toReversed()) {
      if (part.type !== 'tool-invocation' || part.toolInvocation.toolCallId !== toolCallId) {
        continue;
      }
      const { args, toolName } = part.toolInvocation;
      if (toolName !== expectedToolName || args === undefined) {
        throw new Error('Observed delegation input does not match its native invocation.');
      }
      return { args: structuredClone(args), toolName };
    }
  }
  return undefined;
}

/**
 * Correlate concurrent native calls without copying RuntimeData into RequestContext.
 * Requires parent and child memory scope. Configuration must be structured-cloneable.
 * This weak map lives only for the runtime. Durable snapshot resume skips processInput:
 * the host must authorize persisted identity before forwarding resumed events.
 */
export function createDelegatedConversationBinding(
  persist: (identity: DelegatedConversationIdentity) => Promise<void>
): DelegatedConversationBinding {
  const scopes = new WeakMap<DelegationStartContext['requestContext'], ParentIdentity>();
  const inputs = new Map<string, DelegatedOriginalToolCall>();
  const inputKey = (threadId: string, toolCallId: string) => JSON.stringify([threadId, toolCallId]);
  return {
    hooks: {
      beforeToolCall({ input, context, toolName }) {
        if (!toolName.startsWith('agent-')) {
          return;
        }
        const threadId = requireIdentity(readToolExecutionThreadId([input, context]));
        const toolCallId = requireIdentity(readToolCallId([input, context]));
        if (
          !(
            context &&
            typeof context === 'object' &&
            'messages' in context &&
            Array.isArray(context.messages)
          )
        ) {
          throw new Error('Delegation input capture requires the native tool message list.');
        }
        const original = readOriginalToolCall(context.messages, toolCallId, toolName);
        if (!original) {
          throw new Error('The native delegation tool call is absent from its message list.');
        }
        const key = inputKey(threadId, toolCallId);
        if (inputs.has(key)) {
          throw new Error('Delegation input capture already owns this native call.');
        }
        inputs.set(key, original);
      },
    },
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
      const key = inputKey(requireIdentity(context.threadId), requireIdentity(context.toolCallId));
      const originalToolCall = inputs.get(key);
      inputs.delete(key);
      if (originalToolCall && originalToolCall.toolName !== `agent-${context.primitiveId}`) {
        throw new Error('Captured delegation input belongs to a different native agent.');
      }
      scopes.set(context.requestContext, {
        configuration: structuredClone(configuration),
        ...(originalToolCall ? { originalToolCall } : {}),
        parentResourceId: requireIdentity(context.resourceId),
        parentRuntimeRunId: requireIdentity(context.runId),
        parentThreadId: requireIdentity(context.threadId),
        parentToolCallId: requireIdentity(context.toolCallId),
        personaId: requireIdentity(context.primitiveId),
      });
    },
  };
}
