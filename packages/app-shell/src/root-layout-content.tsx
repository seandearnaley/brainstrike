import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import { FileExplorerLeftPanel, useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { FileTreeProvider } from '@brainstrike/file-explorer-ui/tree';
import { ChunkingWorkerProvider } from '@brainstrike/file-import/chunking-worker-context';
import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/preferences/stores/panel-layout-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { IdeLayout, PanelLayoutProvider, type PanelLayoutState } from '@brainstrike/ui';
import {
  EmbeddingRuntimeProvider,
  IndexingActivityCoordinator,
} from '@brainstrike/vector-management';
import {
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shallow } from 'zustand/shallow';
import { AgentSidebarPanel } from './agent-sidebar-panel';
import { AgentWorkspaceLayout } from './agent-workspace-layout';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { AssistantChatPanel } from './assistant-chat-panel';
import { WorkspaceCollectionSyncProvider } from './background-indexing/workspace-collection-sync-provider';
import { DatabasePanel } from './database-panel';
import { ThreadsPanel } from './threads-panel';
import type { NavigationItem } from './types';

interface DebouncedPanelLayoutState {
  readonly showConsole: boolean;
  readonly showLeftPanel: boolean;
  readonly showRightPanel: boolean;
  readonly sizes: [number, number, number];
}

function FileTreeWrapper({ children }: { children: ReactNode }): ReactElement {
  const { rootDirectoryHandle } = useFileSystem();
  return (
    <FileTreeProvider rootDirectoryHandle={rootDirectoryHandle}>
      <WorkspaceCollectionSyncProvider>{children}</WorkspaceCollectionSyncProvider>
    </FileTreeProvider>
  );
}

export interface RootLayoutContentProps {
  readonly contextExplorerLeftPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly databaseTabChunkingMode?: 'host-proxy' | 'local';
  /**
   * CRITICAL: Lazy loader for the app-specific embedding queue adapter.
   *
   * This loader is the single source of truth for app-wide database tooling:
   * RootLayoutContent → AgentSidebarPanel → DatabasePanel → DatabaseTab → DatabaseDemoPanel.
   */
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
  readonly navigationItems: NavigationItem[];
  readonly preloadDatabaseTabOnMount?: boolean;
  readonly promptsPageContent?: ReactNode;
  readonly settingsPageContent: ReactNode;
}

const NAV_PATH_TO_TAB: Record<string, PanelTab> = {
  '/settings': 'settings',
  '/prompts': 'prompts',
};

function resolveActiveTabForPath(path: string): PanelTab {
  return NAV_PATH_TO_TAB[path] ?? 'explorer';
}

function useDebouncedPanelLayoutChange(options: {
  readonly panelState: DebouncedPanelLayoutState;
  readonly setState: (next: DebouncedPanelLayoutState) => void;
}) {
  const { panelState, setState } = options;
  const panelStateRef = useRef(panelState);
  const setStateRef = useRef(setState);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  panelStateRef.current = panelState;
  setStateRef.current = setState;

  const cleanupSizeDebounce = useCallback(() => {
    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
  }, []);

  useEffect(() => cleanupSizeDebounce, [cleanupSizeDebounce]);

  // Stable callback: all mutable panel state flows through refs so resize commits
  // do not recreate the outer or inner layout trees.
  return useCallback((state: PanelLayoutState) => {
    const currentPanelState = panelStateRef.current;
    const fallback = currentPanelState.sizes;
    const nextSizes = [
      (state.sizes?.[0] as number | undefined) ?? fallback[0],
      (state.sizes?.[1] as number | undefined) ?? fallback[1],
      (state.sizes?.[2] as number | undefined) ?? fallback[2],
    ] as [number, number, number];

    const booleansChanged =
      state.showConsole !== currentPanelState.showConsole ||
      state.showLeftPanel !== currentPanelState.showLeftPanel ||
      state.showRightPanel !== currentPanelState.showRightPanel;

    if (booleansChanged) {
      if (sizeDebounceRef.current) {
        clearTimeout(sizeDebounceRef.current);
        sizeDebounceRef.current = null;
      }
      setStateRef.current({
        ...currentPanelState,
        sizes: nextSizes,
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
      });
      return;
    }

    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
    sizeDebounceRef.current = setTimeout(() => {
      sizeDebounceRef.current = null;
      setStateRef.current({
        ...currentPanelState,
        sizes: nextSizes,
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
      });
    }, 150);
  }, []);
}

function ContextExplorerSurface({
  contextExplorerLeftPanelContent,
  contextExplorerPageContent,
}: {
  readonly contextExplorerLeftPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
}): ReactElement {
  const setState = useContextExplorerLayoutStore((state) => state.setState);
  const panelState = useContextExplorerLayoutStore(
    (state) => ({
      sizes: state.sizes,
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
    }),
    shallow
  );
  const handlePanelLayoutChange = useDebouncedPanelLayoutChange({
    panelState,
    setState,
  });
  const resolvedLeftPanelContent = useMemo(
    () => contextExplorerLeftPanelContent ?? <FileExplorerLeftPanel />,
    [contextExplorerLeftPanelContent]
  );

  return (
    <FileTreeWrapper>
      {/* The outer shell owns workspace-vs-assistant geometry; this nested provider owns
          the route-local context explorer panes inside that workspace surface. The
          editor area itself hosts the Context Explorer app and any open file tabs;
          there is no longer a south "console" panel. */}
      <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
        <IdeLayout leftPanelContent={resolvedLeftPanelContent} panelIdPrefix="context-explorer">
          {contextExplorerPageContent}
        </IdeLayout>
      </PanelLayoutProvider>
    </FileTreeWrapper>
  );
}

const ExplorerAppSurface = memo(function ExplorerAppSurface({
  contextExplorerLeftPanelContent,
  contextExplorerPageContent,
  databaseTabChunkingMode,
  loadEmbeddingQueue,
  loadLocalLlmBackend,
  preloadDatabaseTabOnMount,
}: {
  readonly contextExplorerLeftPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly databaseTabChunkingMode: 'host-proxy' | 'local';
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
  readonly preloadDatabaseTabOnMount: boolean;
}): ReactElement {
  return (
    <div className="h-full min-h-0" data-testid="explorer-section">
      <AgentWorkspaceLayout
        assistantContent={
          <AssistantChatPanel {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})} />
        }
        sidebarContent={
          <AgentSidebarPanel
            databaseContent={
              <DatabasePanel
                chunkingMode={databaseTabChunkingMode}
                loadEmbeddingQueue={loadEmbeddingQueue}
              />
            }
            preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
            threadsContent={<ThreadsPanel />}
          />
        }
        workspaceContent={
          <ContextExplorerSurface
            contextExplorerLeftPanelContent={contextExplorerLeftPanelContent}
            contextExplorerPageContent={contextExplorerPageContent}
          />
        }
      />
    </div>
  );
});

export function RootLayoutContent({
  contextExplorerPageContent,
  contextExplorerLeftPanelContent,
  settingsPageContent,
  promptsPageContent,
  navigationItems,
  loadEmbeddingQueue = null,
  loadLocalLlmBackend,
  databaseTabChunkingMode = 'local',
  preloadDatabaseTabOnMount = false,
}: RootLayoutContentProps): ReactElement {
  const activeTab = usePanelLayoutStore((state) => state.activeTab);
  const setState = usePanelLayoutStore((state) => state.setState);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<PanelTab>>(() => new Set([activeTab]));
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  useEffect(() => {
    setMountedTabs((currentTabs) => {
      if (currentTabs.has(activeTab)) {
        return currentTabs;
      }
      const nextTabs = new Set(currentTabs);
      nextTabs.add(activeTab);
      return nextTabs;
    });
  }, [activeTab]);

  const handleNavigationClick = useCallback(
    (path: string) => {
      setState({ activeTab: resolveActiveTabForPath(path) });
    },
    [setState]
  );
  const panelState = usePanelLayoutStore(
    (state) => ({
      sizes: state.sizes,
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
    }),
    shallow
  );
  const handlePanelLayoutChange = useDebouncedPanelLayoutChange({
    panelState,
    setState,
  });

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : `/${activeTab}`}
      onNavigationClick={handleNavigationClick}
    >
      {/* These providers now intentionally stay app-wide so background chunking and embedding
          work can continue across route switches. They remain inert on non-explorer routes
          unless a feature explicitly opts into them. */}
      <ChunkingWorkerProvider autoStart={false} mode={databaseTabChunkingMode}>
        <EmbeddingRuntimeProvider>
          <IndexingActivityCoordinator />
          <div
            aria-hidden={activeTab !== 'explorer'}
            className={activeTab === 'explorer' ? 'h-full min-h-0' : 'hidden h-full min-h-0'}
            data-testid="explorer-route"
          >
            <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
              <ExplorerAppSurface
                contextExplorerLeftPanelContent={contextExplorerLeftPanelContent}
                contextExplorerPageContent={contextExplorerPageContent}
                databaseTabChunkingMode={databaseTabChunkingMode}
                loadEmbeddingQueue={loadEmbeddingQueue}
                {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
              />
            </PanelLayoutProvider>
          </div>
          {mountedTabs.has('prompts') ? (
            <div
              aria-hidden={activeTab !== 'prompts'}
              className={activeTab === 'prompts' ? 'h-full' : 'hidden h-full'}
              data-testid="prompts-route"
            >
              {promptsPageContent ?? null}
            </div>
          ) : null}
          {mountedTabs.has('settings') ? (
            <div
              aria-hidden={activeTab !== 'settings'}
              className={activeTab === 'settings' ? 'h-full' : 'hidden h-full'}
              data-testid="settings-route"
            >
              {settingsPageContent}
            </div>
          ) : null}
        </EmbeddingRuntimeProvider>
      </ChunkingWorkerProvider>
    </AppLayout>
  );
}
