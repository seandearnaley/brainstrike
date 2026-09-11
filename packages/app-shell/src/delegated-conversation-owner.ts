import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import type {
  AssistantUiPanelProps,
  DelegatedConversationRuntimeOptions,
  DelegatedConversationUpdate,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationStore } from './delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from './delegated-decision-dispatcher';

type PublishedRuntime = Parameters<NonNullable<AssistantUiPanelProps['onRuntimeReady']>>[0];
interface Thread {
  readonly append: PublishedRuntime['thread']['append'];
  getState(): Pick<ReturnType<PublishedRuntime['thread']['getState']>, 'threadId'>;
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
  return {
    onDelegatedConversation(update: DelegatedConversationUpdate): void {
      store.publish(update);
    },
    onRuntimeReady(next: Runtime): () => void {
      const thread = next.thread;
      const registration = { thread, threadId: thread.getState().threadId };
      runtime = registration;
      return () => {
        if (runtime === registration) {
          runtime = undefined;
        }
      };
    },
    async sendDecision(
      threadId: string,
      message: DecisionMessage,
      resolvePersistedIdentity?: () => Promise<DelegatedRunIdentity | undefined>
    ): Promise<void> {
      const child = store.getConversation(threadId);
      if (!runtime) {
        throw new Error('The owning conversation is not available for this decision.');
      }
      const owner = runtime;
      const identity = child?.update.identity ?? (await resolvePersistedIdentity?.());
      if (!identity || runtime !== owner || owner.thread.getState().threadId !== owner.threadId) {
        throw new Error(
          'The owning conversation or persisted child binding is no longer available.'
        );
      }
      await createDelegatedDecisionDispatcher(identity, (input) => owner.thread.append(input))(
        message
      );
    },
    store,
  };
}

export type DelegatedConversationRoot = ReturnType<typeof createDelegatedConversationRoot>;
