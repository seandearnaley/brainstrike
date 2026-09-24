import {
  type AssistantMemoryThread,
  resolveAssistantMemoryResourceId,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import type { AssistantUiPanelProps } from '@brainstrike/assistant-ui';
import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { createContext, use, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DelegatedConversationRoot } from './delegated-conversation-owner';
import type { createDelegatedConversationRootRegistry } from './delegated-conversation-root-registry';
export type Roots = ReturnType<typeof createDelegatedConversationRootRegistry>;
export const RootsContext = createContext<Roots | null>(null);
const EMPTY_PROVIDER_SETTINGS: AssistantProviderSettingsMap = {};
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
function useDelegatedPanelBinding(
  ownerResourceId: string,
  rootThreadId: string | undefined,
  selectedModel: string | null = null,
  providerSettings: AssistantProviderSettingsMap = EMPTY_PROVIDER_SETTINGS,
  planMode = false
): Pick<AssistantUiPanelProps, 'onDelegatedConversation' | 'onRuntimeReady'> {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  useEffect(() => {
    root?.modelSelection.setState({ planMode, providerSettings, selectedModel });
  }, [root, selectedModel, providerSettings, planMode]);
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

const EMPTY_MEMORY_THREADS = [] as const;

type AssistantThreadState = ReturnType<typeof useAssistantThreadStore.getState>;
interface AssistantPanelThreadScope {
  readonly delegatedPanelBinding: ReturnType<typeof useDelegatedPanelBinding> &
    Pick<AssistantUiPanelProps, 'agentColor'>;
  readonly ensureResourceThreads: AssistantThreadState['ensureResourceThreads'];
  readonly memoryLoadState: AssistantThreadState['loadStateByResourceId'][string];
  readonly memoryResourceId: string;
  readonly memoryThreads: readonly AssistantMemoryThread[];
  readonly refreshResourceThreads: AssistantThreadState['refreshResourceThreads'];
  readonly resourceThreadsReady: boolean;
  readonly selectedMemoryThreadId: string | undefined;
}

/** Resolve the selected thread and its delegated callbacks from one owner scope. */
export function useAssistantPanelThreadScope(
  resourceIdOverride: string | undefined,
  threadIdOverride: string | undefined,
  selectedModel: string | null,
  providerSettings: AssistantProviderSettingsMap = EMPTY_PROVIDER_SETTINGS,
  planMode = false
): AssistantPanelThreadScope {
  const memoryResourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const refreshResourceThreads = useAssistantThreadStore((state) => state.refreshResourceThreads);
  const memoryThreads = useAssistantThreadStore(
    (state) => state.threadsByResourceId[memoryResourceId] ?? EMPTY_MEMORY_THREADS
  );
  const selectedMemoryThreadId = threadIdOverride ?? selectedThreadByResourceId[memoryResourceId];
  const memoryLoadState = loadStateByResourceId[memoryResourceId] ?? { status: 'idle' as const };
  const delegatedPanelBinding = useDelegatedPanelBinding(
    memoryResourceId,
    selectedMemoryThreadId,
    selectedModel,
    providerSettings,
    planMode
  );
  const agentColor = useMemo(
    () => memoryThreads.find((thread) => thread.id === selectedMemoryThreadId)?.metadata?.color,
    [memoryThreads, selectedMemoryThreadId]
  );
  const coloredDelegatedPanelBinding = useMemo(
    () => ({ ...delegatedPanelBinding, agentColor }),
    [delegatedPanelBinding, agentColor]
  );
  return {
    delegatedPanelBinding: coloredDelegatedPanelBinding,
    ensureResourceThreads,
    memoryLoadState,
    memoryResourceId,
    memoryThreads,
    refreshResourceThreads,
    resourceThreadsReady: memoryLoadState.status === 'ready',
    selectedMemoryThreadId,
  };
}
