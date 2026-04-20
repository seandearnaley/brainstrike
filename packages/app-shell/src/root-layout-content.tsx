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
import { cn, IdeLayout, PanelLayoutProvider, type PanelLayoutState } from '@brainstrike/ui';
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
          rightPanelContent={null}
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
  const [mountedTabs, setMountedTabs] = useState<{
    prompts: boolean;
    settings: boolean;
  }>({
    prompts: activeTab === 'prompts',
    settings: activeTab === 'settings',
  });

  useEffect(() => {
    if (activeTab !== 'prompts' && activeTab !== 'settings') {
      return;
    }
    if (mountedTabs[activeTab]) {
      return;
    }
    setMountedTabs((current) => ({ ...current, [activeTab]: true }));
  }, [activeTab, mountedTabs]);

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

  const appSurfaceContent = useMemo(
    () => (
      <>
        <div
          aria-hidden={activeTab !== 'explorer'}
          className={cn('h-full', activeTab !== 'explorer' && 'hidden')}
          data-testid="explorer-section"
        >
          <ContextExplorerSurface
            contextExplorerLeftPanelContent={contextExplorerLeftPanelContent}
            contextExplorerPageContent={contextExplorerPageContent}
          />
        </div>
        <div
          aria-hidden={activeTab !== 'prompts'}
          className={cn('h-full', activeTab !== 'prompts' && 'hidden')}
          data-testid="prompts-section"
        >
          {mountedTabs.prompts ? promptsPageContent : null}
        </div>
        <div
          aria-hidden={activeTab !== 'settings'}
          className={cn('h-full', activeTab !== 'settings' && 'hidden')}
          data-testid="settings-section"
        >
          {mountedTabs.settings ? settingsPageContent : null}
        </div>
      </>
    ),
    [
      activeTab,
      contextExplorerLeftPanelContent,
      contextExplorerPageContent,
      databaseTabChunkingMode,
      mountedTabs.prompts,
      mountedTabs.settings,
      promptsPageContent,
      settingsPageContent,
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
          <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
            <AgentWorkspaceLayout
              appSurfaceContent={appSurfaceContent}
              assistantContent={<AssistantChatPanel />}
              databaseDrawerContent={
                <DatabaseDrawer
                  chunkingMode={databaseTabChunkingMode}
                  loadEmbeddingQueue={loadEmbeddingQueue}
                  preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
                />
              }
              threadsContent={<ThreadsPanel />}
            />
          </PanelLayoutProvider>
        </EmbeddingRuntimeProvider>
      </ChunkingWorkerProvider>
    </AppLayout>
  );
}
