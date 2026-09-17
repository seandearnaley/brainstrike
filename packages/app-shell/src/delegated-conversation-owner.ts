import {
  CHILD_FOLLOWUP_RUN_CONFIG_KEY,
  type DelegatedRunIdentity,
  getToolActionIdentityKey,
} from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
import { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
import type {
  AssistantUiPanelProps,
  ChildContinuationIdentity,
  DecisionDispatchOutcome,
  DelegatedConversationRuntimeOptions,
  DelegatedConversationUpdate,
} from '@brainstrike/assistant-ui';
import { type LiveDecisionTransport, submitDecisionOrQueue } from '@brainstrike/assistant-ui';
import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { createStore } from 'zustand/vanilla';
import { createDelegatedConversationStore } from './delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from './delegated-decision-dispatcher';

type PublishedRuntime = Parameters<NonNullable<AssistantUiPanelProps['onRuntimeReady']>>[0];
type PublishedThreadState = ReturnType<PublishedRuntime['thread']['getState']>;
/**
 * The owning root's published thread. Child views read its `messages` through
 * `subscribe` for the host's approval answers, which stream on the root leg only.
 */
interface Thread {
  readonly append: PublishedRuntime['thread']['append'];
  getState(): Pick<PublishedThreadState, 'messages' | 'threadId'> &
    Partial<Pick<PublishedThreadState, 'isRunning'>>;
  readonly subscribe: PublishedRuntime['thread']['subscribe'];
}
interface Runtime {
  readonly thread: Thread;
}
interface Registration {
  readonly thread: Thread;
  readonly threadId: string;
}
type DecisionMessage = Parameters<DelegatedConversationRuntimeOptions['onNew']>[0];

/** The pause identity a decision message targets, for the queue's "Queued" state. */
function readDecisionIdentityKey(message: DecisionMessage): string {
  const approval = readToolApprovalRunConfigAction(message.runConfig);
  const resume = readToolResumeRunConfigAction(message.runConfig);
  const result = approval ?? resume;
  if (!(result && 'action' in result)) {
    throw new Error('A child decision message carries no decision.');
  }
  return getToolActionIdentityKey(result.action);
}

export function createDelegatedConversationRoot(rootThreadId: string) {
  const store = createDelegatedConversationStore(rootThreadId);
  const modelSelection = createStore<{
    readonly selectedModel: string | null;
    readonly providerSettings: AssistantProviderSettingsMap;
    readonly planMode: boolean;
  }>(() => ({
    planMode: false,
    providerSettings: {},
    selectedModel: null,
  }));
  let runtime: Registration | undefined;
  let liveDecisionTransport: LiveDecisionTransport | null = null;
  const pending = new Set<() => void>();
  const retirePending = () => {
    for (const retire of [...pending]) {
      retire();
    }
  };
  const ownerListeners = new Set<() => void>();
  const notifyOwner = () => {
    for (const listener of [...ownerListeners]) {
      listener();
    }
  };
  return {
    /** The registered owning thread; child views read the root's host answers from it. */
    getOwnerThread: (): Thread | undefined => runtime?.thread,
    modelSelection,
    onDelegatedConversation(update: DelegatedConversationUpdate): void {
      store.publish(update);
    },
    onRuntimeReady(next: Runtime): () => void {
      const thread = next.thread;
      const registration = { thread, threadId: thread.getState().threadId };
      retirePending();
      runtime = registration;
      notifyOwner();
      return () => {
        if (runtime === registration) {
          runtime = undefined;
          retirePending();
          notifyOwner();
        }
      };
    },
    async sendDecision(
      threadId: string,
      message: DecisionMessage,
      resolvePersistedIdentity?: () => Promise<
        DelegatedRunIdentity | ChildContinuationIdentity | undefined
      >
    ): Promise<DecisionDispatchOutcome> {
      const child = store.getConversation(threadId);
      if (!runtime) {
        throw new Error('The owning conversation is not available for this decision.');
      }
      const owner = runtime;
      const identity =
        child?.update.continuation ??
        (child?.update.identity
          ? {
              ...child.update.identity,
              ...(child.update.continuationId
                ? { continuationId: child.update.continuationId }
                : {}),
            }
          : undefined) ??
        (await resolvePersistedIdentity?.());
      if (!identity || runtime !== owner || owner.thread.getState().threadId !== owner.threadId) {
        throw new Error(
          'The owning conversation or persisted child binding is no longer available.'
        );
      }
      // A child-view decision is the same root append the root card makes,
      // so it obeys the same rule: never cancel an in-flight root run, queue
      // behind it (`decision-dispatch.ts`). `isRunning` is part of the
      // published runtime state; a double that omits it cannot be running.
      const identityKey = readDecisionIdentityKey(message);
      const text = message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim();
      let outcome: DecisionDispatchOutcome | undefined;
      await createDelegatedDecisionDispatcher(identity, async (input) => {
        outcome = await submitDecisionOrQueue({
          append: (queued) => owner.thread.append(queued),
          deliverLive: liveDecisionTransport,
          identityKey,
          isRunning: owner.thread.getState().isRunning === true,
          message: input,
          text,
          threadKey: rootThreadId,
        });
      })(message);
      if (!outcome) {
        throw new Error('The owning conversation did not dispatch the decision.');
      }
      return outcome;
    },
    async sendFollowup(
      threadId: string,
      input: Omit<AssistantChildFollowupAction, 'threadId'>,
      signal: AbortSignal
    ): Promise<void> {
      const owner = runtime;
      if (!owner?.thread.subscribe || owner.thread.getState().threadId !== owner.threadId) {
        throw new Error('The owning conversation is not available for child input.');
      }
      if (owner.thread.getState().isRunning !== false || pending.size > 0) {
        throw new Error(
          'Wait for the owning conversation to finish before continuing an idle child.'
        );
      }
      signal.throwIfAborted();
      const subscribe = owner.thread.subscribe.bind(owner.thread);
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        let sawRun = false;
        const cleanups: (() => void)[] = [];
        const finish = (error?: unknown) => {
          if (finished) {
            return;
          }
          finished = true;
          for (const cleanup of cleanups) {
            cleanup();
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const fail = (error: unknown) =>
          finish(
            error instanceof Error
              ? error
              : new Error('Child input delivery was not confirmed.', { cause: error })
          );
        const lostOwner = () =>
          finish(new Error('Child input was not confirmed before its owner retired.'));
        const onAbort = () =>
          fail(signal.reason ?? new Error('Child input acknowledgement wait stopped.'));
        pending.add(lostOwner);
        cleanups.push(() => pending.delete(lostOwner));
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
        cleanups.push(
          store.subscribe(() => {
            const continuation = store.getConversation(threadId)?.update.continuation;
            if (continuation?.continuationId === input.id) {
              finish();
            }
          })
        );
        cleanups.push(
          subscribe(() => {
            const state = owner.thread.getState();
            if (runtime !== owner || state.threadId !== owner.threadId) {
              lostOwner();
              return;
            }
            if (state.isRunning) {
              sawRun = true;
            } else if (sawRun) {
              finish(new Error('Child input was not confirmed before the owning run ended.'));
            }
          })
        );
        const action = { ...input, threadId };
        const custom = { [CHILD_FOLLOWUP_RUN_CONFIG_KEY]: action };
        try {
          void Promise.resolve(
            owner.thread.append({
              // Images belong to the child action, never the parent's model input.
              content: [{ text: input.text, type: 'text' }],
              metadata: { custom },
              role: 'user',
              runConfig: { custom },
              startRun: true,
            })
          ).catch(fail);
        } catch (error) {
          fail(error);
        }
      });
    },
    /** The host's live decision transport (desktop), shared with the root cards. */
    setLiveDecisionTransport(transport: LiveDecisionTransport | null): void {
      liveDecisionTransport = transport;
    },
    store,
    subscribeOwner(listener: () => void): () => void {
      ownerListeners.add(listener);
      return () => {
        ownerListeners.delete(listener);
      };
    },
  };
}

export type DelegatedConversationRoot = ReturnType<typeof createDelegatedConversationRoot>;
