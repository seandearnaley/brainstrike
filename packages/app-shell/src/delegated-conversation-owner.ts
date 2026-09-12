import {
  CHILD_FOLLOWUP_RUN_CONFIG_KEY,
  type DelegatedRunIdentity,
} from '@brainstrike/assistant-contract';
import type {
  AssistantUiPanelProps,
  ChildContinuationIdentity,
  DelegatedConversationRuntimeOptions,
  DelegatedConversationUpdate,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationStore } from './delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from './delegated-decision-dispatcher';

type PublishedRuntime = Parameters<NonNullable<AssistantUiPanelProps['onRuntimeReady']>>[0];
interface Thread {
  readonly append: PublishedRuntime['thread']['append'];
  getState(): Pick<ReturnType<PublishedRuntime['thread']['getState']>, 'threadId'> &
    Partial<Pick<ReturnType<PublishedRuntime['thread']['getState']>, 'isRunning'>>;
  readonly subscribe?: PublishedRuntime['thread']['subscribe'];
}
interface Runtime {
  readonly thread: Thread;
}
interface Registration {
  readonly thread: Thread;
  readonly threadId: string;
}
type DecisionMessage = Parameters<DelegatedConversationRuntimeOptions['onNew']>[0];

export function createDelegatedConversationRoot(rootThreadId: string) {
  const store = createDelegatedConversationStore(rootThreadId);
  let runtime: Registration | undefined;
  const pending = new Set<() => void>();
  const retirePending = () => {
    for (const retire of [...pending]) {
      retire();
    }
  };
  return {
    onDelegatedConversation(update: DelegatedConversationUpdate): void {
      store.publish(update);
    },
    onRuntimeReady(next: Runtime): () => void {
      const thread = next.thread;
      const registration = { thread, threadId: thread.getState().threadId };
      retirePending();
      runtime = registration;
      return () => {
        if (runtime === registration) {
          runtime = undefined;
          retirePending();
        }
      };
    },
    async sendDecision(
      threadId: string,
      message: DecisionMessage,
      resolvePersistedIdentity?: () => Promise<
        DelegatedRunIdentity | ChildContinuationIdentity | undefined
      >
    ): Promise<void> {
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
      await createDelegatedDecisionDispatcher(identity, (input) => owner.thread.append(input))(
        message
      );
    },
    async sendFollowup(
      threadId: string,
      input: { readonly id: string; readonly text: string },
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
    store,
  };
}

export type DelegatedConversationRoot = ReturnType<typeof createDelegatedConversationRoot>;
