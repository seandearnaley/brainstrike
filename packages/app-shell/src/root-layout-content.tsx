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
import { Database } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';
import { AgentWorkspaceLayout } from './agent-workspace-layout';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { AssistantChatPanel } from './assistant-chat-panel';
import { WorkspaceCollectionSyncProvider } from './background-indexing/workspace-collection-sync-provider';
import { DatabaseDrawer } from './database-drawer';
import { ThreadsPanel } from './threads-panel';
import type { NavigationItem } from './types';

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
   * RootLayoutContent → DatabaseDrawer → DatabaseTab → DatabaseDemoPanel.
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

function useDebouncedPanelLayoutChange<T extends PanelLayoutState>(options: {
  readonly panelState: T;
  readonly setState: (next: T) => void;
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
          ...(panelState as T),
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
          ...(panelState as T),
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
  databaseTabChunkingMode,
  loadEmbeddingQueue,
  preloadDatabaseTabOnMount,
}: {
  readonly contextExplorerLeftPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly databaseTabChunkingMode: 'host-proxy' | 'local';
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
  readonly preloadDatabaseTabOnMount: boolean;
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
          rightPanelChrome={{
            title: 'Database',
            showButtonLabel: 'Show database panel',
            showButtonTestId: 'show-database-panel',
            hideButtonLabel: 'Hide database panel',
            hideButtonTestId: 'hide-database-panel',
            icon: Database,
          }}
          rightPanelContent={
            <DatabaseDrawer
              chunkingMode={databaseTabChunkingMode}
              preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
              {...(loadEmbeddingQueue === undefined ? {} : { loadEmbeddingQueue })}
            />
          }
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
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

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
      <div className="h-full" data-testid="explorer-section">
        <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
          <AgentWorkspaceLayout
            assistantContent={<AssistantChatPanel />}
            threadsContent={<ThreadsPanel />}
            workspaceContent={
              <ContextExplorerSurface
                contextExplorerLeftPanelContent={contextExplorerLeftPanelContent}
                contextExplorerPageContent={contextExplorerPageContent}
                databaseTabChunkingMode={databaseTabChunkingMode}
                loadEmbeddingQueue={loadEmbeddingQueue}
                preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
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

  const activeRouteContent = useMemo(() => {
    if (activeTab === 'explorer') {
      return explorerAppContent;
    }
    if (activeTab === 'prompts') {
      return (
        <div className="h-full" data-testid="prompts-route">
          {promptsPageContent ?? null}
        </div>
      );
    }
    return (
      <div className="h-full" data-testid="settings-route">
        {settingsPageContent}
      </div>
    );
  }, [activeTab, explorerAppContent, promptsPageContent, settingsPageContent]);

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : `/${activeTab}`}
      onNavigationClick={handleNavigationClick}
    >
      <ChunkingWorkerProvider autoStart={false} mode={databaseTabChunkingMode}>
        <EmbeddingRuntimeProvider>{activeRouteContent}</EmbeddingRuntimeProvider>
      </ChunkingWorkerProvider>
    </AppLayout>
  );
}
