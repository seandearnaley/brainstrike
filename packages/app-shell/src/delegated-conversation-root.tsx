import type {
  AssistantUiPanelProps,
  DelegatedConversationRuntimeOptions,
  DelegatedConversationUpdate,
} from '@brainstrike/assistant-ui';
import { createContext, type ReactNode, use, useMemo, useState } from 'react';
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
type Roots = Map<string, DelegatedConversationRoot>;
const RootsContext = createContext<Roots | null>(null);

/** Ephemeral roots live above child views and alongside the existing workspace tabs. */
export function DelegatedConversationRootsProvider({ children }: { readonly children: ReactNode }) {
  const [roots] = useState<Roots>(() => new Map());
  return <RootsContext value={roots}>{children}</RootsContext>;
}

export function useDelegatedConversationRoot(
  ownerResourceId: string,
  rootThreadId: string | undefined
) {
  const roots = use(RootsContext);
  return useMemo(() => {
    if (!(roots && rootThreadId)) {
      return;
    }
    const key = JSON.stringify([ownerResourceId, rootThreadId]);
    let root = roots.get(key);
    if (!root) {
      root = createDelegatedConversationRoot(rootThreadId);
      roots.set(key, root);
    }
    return root;
  }, [roots, ownerResourceId, rootThreadId]);
}
