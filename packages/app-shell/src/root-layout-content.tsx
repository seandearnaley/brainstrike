import {
  FileExplorerLeftPanel,
  FileTreeProvider,
  TabbedFileEditorPanel,
  useFileSystem,
} from '@brainstrike/file-explorer-ui';
import { ChunkingWorkerProvider } from '@brainstrike/file-import/chunking-worker-context';
import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/preferences/stores/panel-layout-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { IdeLayout, PanelLayoutProvider, type PanelLayoutState } from '@brainstrike/ui';
import { EmbeddingRuntimeProvider } from '@brainstrike/vector-management';
import {
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
  const sizesRef = useRef(panelState.sizes);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  sizesRef.current = panelState.sizes;

  const cleanupSizeDebounce = useCallback(() => {
    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
  }, []);

  useEffect(() => cleanupSizeDebounce, [cleanupSizeDebounce]);

  return useCallback(
    (state: PanelLayoutState) => {
      const fallback = sizesRef.current;
      const nextSizes = [
        (state.sizes?.[0] as number | undefined) ?? fallback[0],
        (state.sizes?.[1] as number | undefined) ?? fallback[1],
        (state.sizes?.[2] as number | undefined) ?? fallback[2],
      ] as [number, number, number];

      const booleansChanged =
        state.showConsole !== panelState.showConsole ||
        state.showLeftPanel !== panelState.showLeftPanel ||
        state.showRightPanel !== panelState.showRightPanel;

      if (booleansChanged) {
        if (sizeDebounceRef.current) {
          clearTimeout(sizeDebounceRef.current);
          sizeDebounceRef.current = null;
        }
        setState({
          ...panelState,
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
        setState({
          ...panelState,
          sizes: nextSizes,
          showConsole: state.showConsole,
          showLeftPanel: state.showLeftPanel,
          showRightPanel: state.showRightPanel,
        });
      }, 150);
    },
    [panelState, setState]
  );
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
  const consoleContent = useMemo(() => <TabbedFileEditorPanel className="h-full" />, []);

  return (
    <FileTreeWrapper>
      <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
        <IdeLayout
          consoleContent={consoleContent}
          leftPanelContent={resolvedLeftPanelContent}
          panelIdPrefix="context-explorer"
        >
          {contextExplorerPageContent}
        </IdeLayout>
      </PanelLayoutProvider>
    </FileTreeWrapper>
  );
}

export function RootLayoutContent({
  contextExplorerPageContent,
  contextExplorerLeftPanelContent,
  settingsPageContent,
  promptsPageContent,
  navigationItems,
  loadEmbeddingQueue = null,
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

  const explorerAppContent = useMemo(
    () => (
      <div className="h-full min-h-0" data-testid="explorer-section">
        <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
          <AgentWorkspaceLayout
            assistantContent={<AssistantChatPanel />}
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
        </PanelLayoutProvider>
      </div>
    ),
    [
      contextExplorerLeftPanelContent,
      contextExplorerPageContent,
      databaseTabChunkingMode,
      panelState,
      handlePanelLayoutChange,
      loadEmbeddingQueue,
      preloadDatabaseTabOnMount,
    ]
  );

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : `/${activeTab}`}
      onNavigationClick={handleNavigationClick}
    >
      <ChunkingWorkerProvider autoStart={false} mode={databaseTabChunkingMode}>
        <EmbeddingRuntimeProvider>
          <div
            aria-hidden={activeTab !== 'explorer'}
            className={activeTab === 'explorer' ? 'h-full min-h-0' : 'hidden h-full min-h-0'}
            data-testid="explorer-route"
          >
            {explorerAppContent}
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
