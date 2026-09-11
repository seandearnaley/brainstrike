import type { AssistantUiPanelProps } from '@brainstrike/assistant-ui';
import { createContext, use, useMemo } from 'react';
import {
  createDelegatedConversationRoot,
  type DelegatedConversationRoot,
} from './delegated-conversation-owner';
export type Roots = Map<string, DelegatedConversationRoot>;
export const RootsContext = createContext<Roots | null>(null);
export function useDelegatedConversationRoot(
  ownerResourceId: string,
  rootThreadId: string | undefined
): DelegatedConversationRoot | undefined {
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

/** The composition wrapper receives a stable capability-shaped callback bundle. */
export function useDelegatedPanelBinding(
  ownerResourceId: string,
  rootThreadId: string | undefined
): Pick<AssistantUiPanelProps, 'onDelegatedConversation' | 'onRuntimeReady'> {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  return useMemo(
    () =>
      root
        ? {
            onDelegatedConversation: root.onDelegatedConversation,
            onRuntimeReady: root.onRuntimeReady,
          }
        : {},
    [root]
  );
}
