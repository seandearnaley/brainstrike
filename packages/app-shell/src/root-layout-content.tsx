import {
  FileExplorerLeftPanel,
  FileTreeProvider,
  TabbedFileEditorPanel,
  useFileSystem,
} from '@brainstrike/file-explorer-ui';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/preferences/stores/panel-layout-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { cn, IdeLayout, PanelLayoutProvider, type PanelLayoutState } from '@brainstrike/ui';
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
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { ToolsPanel } from './tools-panel';
import type { NavigationItem } from './types';

/**
 * Wrapper that provides shared file tree state to all explorer panels.
 * This ensures that when expand-all completes in the left panel,
 * the middle panel and tabbed editor panel see the same updated tree
 * for file content loading.
 *
 * Note: The workspace filter function is handled internally by useFileExplorer
 * which creates its own filterTreeFn. This wrapper just provides the shared
 * tree state without the filter function since it can't access the store context.
 */
function FileTreeWrapper({ children }: { children: ReactNode }): ReactElement {
  const { rootDirectoryHandle } = useFileSystem();
  return <FileTreeProvider rootDirectoryHandle={rootDirectoryHandle}>{children}</FileTreeProvider>;
}

export interface RootLayoutContentProps {
  readonly databaseTabChunkingMode?: 'host-proxy' | 'local';
  readonly homePageContent: ReactNode;

  /**
   * Optional custom left panel content.
   * If not provided, defaults to FileExplorerLeftPanel.
   * Use this to wrap the left panel with app-specific providers (e.g., TokenCacheProvider).
   */
  readonly leftPanelContent?: ReactNode;
  /**
   * CRITICAL: Lazy loader for the app-specific embedding queue adapter.
   *
   * The queue module is defined at the app entry point:
   * - Desktop: apps/desktop/src/renderer/create-embedding-queue.ts
   * - Web: apps/web/src/create-embedding-queue.ts
   *
   * The loader is passed down from here to:
   * - ToolsPanel → DatabaseTab → DatabaseDemoPanel (embedding controls and import operations)
   * so startup does not eagerly construct the workerpool-backed embedding runtime
   * before the database tools are actually opened.
   *
   * DO NOT remove this prop path! It's critical for:
   * - Embedding set management UI
   * - File import embedding generation
   * - Vector search operations
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

export function RootLayoutContent({
  homePageContent,
  settingsPageContent,
  promptsPageContent,
  navigationItems,
  leftPanelContent,
  loadEmbeddingQueue = null,
  databaseTabChunkingMode = 'local',
  preloadDatabaseTabOnMount = false,
}: RootLayoutContentProps): ReactElement {
  const activeTab = usePanelLayoutStore((s) => s.activeTab);
  const setState = usePanelLayoutStore((s) => s.setState);
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

  // CRITICAL: Pass loadEmbeddingQueue to ToolsPanel
  // The queue flows:
  // - RootLayoutContent → ToolsPanel → DatabaseTab → DatabaseDemoPanel (embedding controls and import operations)
  const rightPanelContent = useMemo(
    () => (
      <ToolsPanel
        chunkingMode={databaseTabChunkingMode}
        loadEmbeddingQueue={loadEmbeddingQueue}
        preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
      />
    ),
    [databaseTabChunkingMode, loadEmbeddingQueue, preloadDatabaseTabOnMount]
  );

  // Memoize panel content elements so resize drags don't bust IdeLayout's React.memo.
  // Without this, every panelState.sizes change (60fps during drag) creates new JSX
  // element references → IdeLayout re-renders → FileExplorerLeftPanel and
  // TabbedFileEditorPanel fully re-render on every frame.
  const resolvedLeftPanelContent = useMemo(
    () => leftPanelContent ?? <FileExplorerLeftPanel />,
    [leftPanelContent]
  );
  const consoleContent = useMemo(() => <TabbedFileEditorPanel className="h-full" />, []);

  // Controlled panel layout state from store
  // shallow equality prevents re-renders when the selected values haven't changed
  const panelState = usePanelLayoutStore(
    (s) => ({
      sizes: s.sizes,
      showConsole: s.showConsole,
      showLeftPanel: s.showLeftPanel,
      showRightPanel: s.showRightPanel,
    }),
    shallow
  );

  // Use a ref for sizes fallback to avoid recreating this callback on every resize drag frame.
  const sizesRef = useRef(panelState.sizes);
  sizesRef.current = panelState.sizes;

  // Trailing-edge debounce: during panel drag, react-resizable-panels manages layout
  // visually via CSS (defaultLayout, not controlled). The Zustand update is purely for
  // persistence. Deferring it to drag-end avoids a re-render cascade on every frame:
  // setState → panelState changes → RootLayoutContent re-renders → PanelLayoutProvider
  // creates new context → IdeLayout re-renders.
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up pending debounce on unmount to prevent stale setState calls.
  useEffect(() => {
    return () => {
      if (sizeDebounceRef.current) {
        clearTimeout(sizeDebounceRef.current);
      }
    };
  }, []);

  const handlePanelLayoutChange = useCallback(
    (state: PanelLayoutState) => {
      const fallback = sizesRef.current;
      const nextSizes = [
        (state.sizes?.[0] as number | undefined) ?? fallback[0],
        (state.sizes?.[1] as number | undefined) ?? fallback[1],
        (state.sizes?.[2] as number | undefined) ?? fallback[2],
      ] as [number, number, number];

      // Boolean toggles (show/hide panel) are committed immediately for instant feedback.
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
          sizes: nextSizes,
          showConsole: state.showConsole,
          showLeftPanel: state.showLeftPanel,
          showRightPanel: state.showRightPanel,
        });
        return;
      }

      // Size-only updates are debounced (trailing edge, 150ms after last drag frame).
      if (sizeDebounceRef.current) {
        clearTimeout(sizeDebounceRef.current);
      }
      sizeDebounceRef.current = setTimeout(() => {
        sizeDebounceRef.current = null;
        setState({
          sizes: nextSizes,
          showConsole: state.showConsole,
          showLeftPanel: state.showLeftPanel,
          showRightPanel: state.showRightPanel,
        });
      }, 150);
    },
    [setState, panelState.showConsole, panelState.showLeftPanel, panelState.showRightPanel]
  );

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : `/${activeTab}`}
      onNavigationClick={handleNavigationClick}
    >
      {/* All panels rendered simultaneously with CSS visibility toggling to preserve state */}
      <div
        aria-hidden={activeTab !== 'explorer'}
        className={cn('h-full', activeTab !== 'explorer' && 'hidden')}
        data-testid="explorer-section"
      >
        {/* FileTreeWrapper provides shared file tree state to all explorer panels.
            This ensures expand-all updates are seen by all panels for file content loading. */}
        <FileTreeWrapper>
          <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
            <IdeLayout
              consoleContent={consoleContent}
              leftPanelContent={resolvedLeftPanelContent}
              rightPanelContent={rightPanelContent}
            >
              {homePageContent}
            </IdeLayout>
          </PanelLayoutProvider>
        </FileTreeWrapper>
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
    </AppLayout>
  );
}
