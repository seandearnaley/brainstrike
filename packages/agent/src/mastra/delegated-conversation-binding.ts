import type {
  AssistantChildInput,
  ChildExecutionConfiguration,
  DelegatedBudgetPort,
  DelegatedConversationBaseline,
  DelegatedOriginalToolCall,
  DelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import { admittedPersonaConfigurationSchema } from '@brainstrike/assistant-contract';
import { type DelegationStartContext, MessageList } from '@mastra/core/agent';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor } from '@mastra/core/processors';
import type { ToolHooks } from '@mastra/core/tools';
import { readToolCallId, readToolExecutionThreadId } from '../tools/read-tool-call-id';
import type { ChildContinuationHostPort } from './child-continuation-host-port';
import type { PrepareChildInputContext } from './child-input-context';
import type { DelegatedRunIdentity } from './delegated-run-publication';
import type { LiveDecisionRequest } from './live-decision-channel';

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

/** A delegated leaf decision the host records as answered (`recordToolActionAnswers`). */
export interface DelegatedToolActionAnswer {
  readonly delegation: DelegatedToolActionIdentity;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface DelegatedToolActionScope {
  /** Admission-time profile and effective budget, read from the authorized child record. */
  readonly configuration?: unknown;
  readonly identity: DelegatedRunIdentity;
  readonly originalToolCall?: DelegatedOriginalToolCall;
  readonly resourceId: string;
  readonly threadId: string;
}

export type DelegatedCancellationTarget = Pick<
  DelegatedRunIdentity,
  'parentRuntimeRunId' | 'parentToolCallId'
>;
export type DelegatedCancellationControl = (
  targets: readonly DelegatedCancellationTarget[]
) => Promise<void>;

/**
 * A decision delivered into the RUNNING leg (POST /assistant/decide): the
 * leg validates and records it, resumes the parked child in-process and
 * publishes the host's answer on its own stream. Rejects with
 * `LiveDecisionUnavailableError` when the leg is not live for that decision.
 */
export type DelegatedDecisionRequest = LiveDecisionRequest;
export type DelegatedDecisionControl = (request: DelegatedDecisionRequest) => Promise<void>;

export interface DelegatedFollowupTarget {
  readonly identity: DelegatedRunIdentity;
  readonly personaId: string;
  readonly resourceId: string;
  readonly runId: string;
  readonly threadId: string;
}
export type DelegatedFollowupInput = AssistantChildInput;
export type DelegatedFollowupControl = (
  target: DelegatedFollowupTarget,
  input: DelegatedFollowupInput,
  assertAdmission: () => Promise<void>,
  prepareContext?: PrepareChildInputContext
) => Promise<void>;

export type DelegatedPromptManifestKind = 'root-leg' | 'child-first-step' | 'continuation';
export interface DelegatedPromptManifestRecord {
  readonly delegationPrompt?: string;
  readonly kind: DelegatedPromptManifestKind;
  readonly model?: string;
  readonly nativeRunId?: string;
  readonly parentToolCallId?: string;
  readonly personaId?: string;
  readonly personaInstructions?: string;
  readonly provider?: string;
  readonly systemContextSource: 'captured' | 'root-leg' | 'none';
  readonly systemMessages: readonly { readonly content: string; readonly role: 'system' }[];
  readonly threadId: string;
  readonly toolNames: readonly string[];
}
export interface DelegatedWakeupInvocation {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'late' | 'deferred';
  readonly taskId: string | null;
  readonly toolCallId: string;
  readonly toolName: string | null;
}
export interface DelegatedWakeupRecord {
  readonly directive: string;
  readonly invocations: readonly DelegatedWakeupInvocation[];
  readonly kind: 'idle-loop' | 'resume-leg' | 'late-overlay' | 'deferred';
}
export interface DelegatedLiveDecisionRecord {
  readonly answeredSiblingTaskIds?: readonly string[];
  readonly decision?: 'approve' | 'decline' | 'resume';
  readonly delegationToolCallId?: string;
  readonly kind: 'approval' | 'resume';
  readonly outcome:
    | 'delivered'
    | 'no-live-run'
    | 'refused'
    | 'failed'
    | 'remembered-answered'
    | 'remembered-failed';
  readonly policySnapshot?: unknown;
  readonly reason?: string;
  readonly source: 'user' | 'remembered-grant';
  readonly taskId?: string;
  readonly toolCallId: string;
  readonly toolName?: string;
}

export interface DelegatedConversationBinding {
  readonly abortInvocations?: (targets: readonly DelegatedCancellationTarget[]) => void;
  /** Host capability required for durable invocation publication/resume authorization. */
  readonly bindRun?: (identity: DelegatedRunIdentity) => Promise<{
    readonly threadId: string;
    readonly messageId?: string;
    readonly baseline?: DelegatedConversationBaseline;
  }>;
  readonly budget?: DelegatedBudgetPort;
  /** Exact settings supplied by the constructed native child before its first input persists. */
  readonly captureExecutionConfiguration?: (
    context: DelegationStartContext['requestContext'],
    execution: ChildExecutionConfiguration
  ) => void;
  /** Atomic admission after native snapshot validation, held through runtime disposal. */
  readonly claimToolAction?: (action: {
    readonly continuationId?: string;
    readonly delegation?: DelegatedToolActionIdentity;
    readonly runId: string;
    readonly toolCallId: string;
  }) => Promise<void>;
  readonly continuation?: ChildContinuationHostPort;
  /** Releases only claims acquired by this binding; consumed leaf ids remain durable. */
  readonly finishToolActions?: () => Promise<void>;
  readonly getAbortSignal?: (
    context: DelegationStartContext['requestContext']
  ) => AbortSignal | undefined;
  readonly hooks?: ToolHooks;
  readonly inputProcessor: InputProcessor;
  prepare(
    context: DelegationStartContext,
    configuration: unknown,
    parentSignal?: AbortSignal
  ): void;
  /** Freeze child history after admission and before invoking native resume. */
  readonly prepareToolAction?: NonNullable<DelegatedConversationBinding['claimToolAction']>;
  /**
   * `recordLiveDecision`, `recordPromptManifest` and `recordWakeup` write
   * debug-pack evidence (migration 139): host-owned, append-only, never runtime
   * authority. The host logs a failed write with a code and resolves — a
   * diagnostic record never fails the leg (swarm diagnostics plan, ruling 4).
   */
  readonly recordLiveDecision?: (record: DelegatedLiveDecisionRecord) => Promise<void>;
  readonly recordPromptManifest?: (record: DelegatedPromptManifestRecord) => Promise<void>;
  /**
   * Record the decisions a RUNNING leg answers at once — a live user decision
   * and every parked sibling a session grant covers — as consumed, ALL OR
   * NONE: one write that records nothing when any answer is refused, so a
   * sibling answered concurrently can never leave the user's own pause
   * consumed and unresumed (BST-1749 review). They are not pending user
   * decisions, so they never take the root's single active claim; the unique
   * leaf key still forbids answering the same pause twice (settled 2026-09-14,
   * thread-796a942d: claiming siblings hit
   * `tool-action-already-consumed-or-root-busy`).
   */
  readonly recordToolActionAnswers?: (
    actions: readonly DelegatedToolActionAnswer[]
  ) => Promise<void>;
  readonly recordWakeup?: (record: DelegatedWakeupRecord) => Promise<void>;
  readonly registerCancellation?: (control: DelegatedCancellationControl) => () => void;
  readonly registerDecisionControl?: (control: DelegatedDecisionControl) => () => void;
  readonly registerFollowup?: (control: DelegatedFollowupControl) => () => void;
  /** Roll back this owner's claim only when native resume has not been invoked. */
  readonly releaseUnexecutedToolAction?: NonNullable<
    DelegatedConversationBinding['claimToolAction']
  >;
  /**
   * Read-only lookup of the child one parent address dispatched, or `undefined`
   * when that address delegated nothing. The approval leg walks parked
   * background siblings from their dispatch address with it, because no leaf
   * identity exists yet to authorize through `resolveToolAction` (which
   * refuses a bare address by design: `tool-action-leaf-identity-required`).
   */
  readonly resolveParkedInvocation?: (parent: {
    readonly parentRuntimeRunId: string;
    readonly parentThreadId: string;
    readonly parentToolCallId: string;
  }) => Promise<DelegatedToolActionScope | undefined>;
  /** Read-only authorization of a decision path against the original host-owned graph. */
  readonly resolveToolAction?: (action: {
    readonly continuationId?: string;
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
  const controllers = new Map<string, AbortController>();
  const preparedKeys = new Map<string, string>();
  const signals = new WeakMap<DelegationStartContext['requestContext'], AbortSignal>();
  const invocationKey = (identity: DelegatedCancellationTarget) =>
    JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);
  const inputKey = (threadId: string, toolCallId: string) => JSON.stringify([threadId, toolCallId]);
  return {
    abortInvocations(targets) {
      for (const target of targets) {
        controllers
          .get(invocationKey(target))
          ?.abort(new Error('Delegated conversation stopped by user.'));
      }
    },
    captureExecutionConfiguration(context, execution) {
      const parent = scopes.get(context);
      if (!parent) {
        throw new Error('Child execution configuration has no trusted native admission.');
      }
      const configuration = admittedPersonaConfigurationSchema.parse(parent.configuration);
      scopes.set(context, {
        ...parent,
        configuration: structuredClone({ ...configuration, execution }),
      });
    },
    getAbortSignal: (context) => signals.get(context),
    hooks: {
      afterToolCall({ input, context, toolName }) {
        // Snapshot resume has no process-local prepared controller to release.
        if (preparedKeys.size === 0 || !toolName.startsWith('agent-')) {
          return;
        }
        const threadId = requireIdentity(readToolExecutionThreadId([input, context]));
        const toolCallId = requireIdentity(readToolCallId([input, context]));
        const preparedKey = inputKey(threadId, toolCallId);
        const nativeKey = preparedKeys.get(preparedKey);
        if (nativeKey) {
          controllers.delete(nativeKey);
          preparedKeys.delete(preparedKey);
        }
      },
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
    prepare(context, configuration, parentSignal) {
      if (scopes.has(context.requestContext)) {
        throw new Error('Delegated conversation parent binding already exists.');
      }
      const key = inputKey(requireIdentity(context.threadId), requireIdentity(context.toolCallId));
      const originalToolCall = inputs.get(key);
      inputs.delete(key);
      if (originalToolCall && originalToolCall.toolName !== `agent-${context.primitiveId}`) {
        throw new Error('Captured delegation input belongs to a different native agent.');
      }
      const controller = new AbortController();
      const nativeKey = invocationKey({
        parentRuntimeRunId: requireIdentity(context.runId),
        parentToolCallId: requireIdentity(context.toolCallId),
      });
      if (controllers.has(nativeKey)) {
        throw new Error('Delegated cancellation already owns this native invocation.');
      }
      controllers.set(nativeKey, controller);
      preparedKeys.set(key, nativeKey);
      signals.set(
        context.requestContext,
        parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
      );
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
