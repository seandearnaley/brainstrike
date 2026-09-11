import type {
  AssistantUiPanelProps,
  DelegatedConversationRuntimeOptions,
  DelegatedConversationUpdate,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationStore } from './delegated-conversation-store';
import { createDelegatedDecisionDispatcher } from './delegated-decision-dispatcher';

type PublishedRuntime = Parameters<NonNullable<AssistantUiPanelProps['onRuntimeReady']>>[0];
interface Runtime {
  readonly thread: Pick<PublishedRuntime['thread'], 'append'>;
}
type DecisionMessage = Parameters<DelegatedConversationRuntimeOptions['onNew']>[0];

export function createDelegatedConversationRoot(rootThreadId: string) {
  const store = createDelegatedConversationStore(rootThreadId);
  let runtime: Runtime | undefined;
  return {
    onDelegatedConversation(update: DelegatedConversationUpdate): void {
      store.publish(update);
    },
    onRuntimeReady(next: Runtime): () => void {
      runtime = next;
      return () => {
        if (runtime === next) {
          runtime = undefined;
        }
      };
    },
    async sendDecision(threadId: string, message: DecisionMessage): Promise<void> {
      const child = store.getConversation(threadId);
      if (!(runtime && child)) {
        throw new Error('The owning conversation is not available for this decision.');
      }
      const owner = runtime;
      await createDelegatedDecisionDispatcher(child.update.identity, (input) =>
        owner.thread.append(input)
      )(message);
    },
    store,
  };
}

export type DelegatedConversationRoot = ReturnType<typeof createDelegatedConversationRoot>;
