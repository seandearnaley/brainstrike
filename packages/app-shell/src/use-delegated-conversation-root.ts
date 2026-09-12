import type { AssistantUiPanelProps } from '@brainstrike/assistant-ui';
import { createContext, use, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DelegatedConversationRoot } from './delegated-conversation-owner';
import type { createDelegatedConversationRootRegistry } from './delegated-conversation-root-registry';
export type Roots = ReturnType<typeof createDelegatedConversationRootRegistry>;
export const RootsContext = createContext<Roots | null>(null);
const emptySubscribe = () => () => undefined;
export function useDelegatedConversationRoot(
  ownerResourceId: string,
  rootThreadId: string | undefined
): DelegatedConversationRoot | undefined {
  const roots = use(RootsContext);
  const scope = useMemo(
    () => (rootThreadId ? { ownerResourceId, rootThreadId } : undefined),
    [ownerResourceId, rootThreadId]
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      roots && scope ? roots.subscribe(scope, listener) : emptySubscribe(),
    [roots, scope]
  );
  const getSnapshot = useCallback(
    () => (roots && scope ? roots.get(scope) : undefined),
    [roots, scope]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The composition wrapper receives a stable capability-shaped callback bundle. */
export function useDelegatedPanelBinding(
  ownerResourceId: string,
  rootThreadId: string | undefined,
  selectedModel: string | null = null
): Pick<AssistantUiPanelProps, 'onDelegatedConversation' | 'onRuntimeReady'> {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  useEffect(() => {
    root?.modelSelection.setState({ selectedModel });
  }, [root, selectedModel]);
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
