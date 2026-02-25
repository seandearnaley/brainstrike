import {
  FileExplorerLeftPanel,
  FileTreeProvider,
  TabbedFileEditorPanel,
  useFileSystem,
} from '@brainstrike/file-explorer-ui';
import { type PanelTab, usePanelLayoutStore } from '@brainstrike/preferences';
import type { QueueAdapter } from '@brainstrike/queue';
import { cn, IdeLayout, PanelLayoutProvider, type PanelLayoutState } from '@brainstrike/ui';
import { type ReactElement, type ReactNode, useCallback, useMemo } from 'react';
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
  readonly homePageContent: ReactNode;
  readonly settingsPageContent: ReactNode;
  readonly promptsPageContent?: ReactNode;
  readonly navigationItems: NavigationItem[];

  /**
   * Optional custom left panel content.
   * If not provided, defaults to FileExplorerLeftPanel.
   * Use this to wrap the left panel with app-specific providers (e.g., TokenCacheProvider).
   */
  readonly leftPanelContent?: ReactNode;

  /**
   * CRITICAL: The app-specific embedding queue adapter.
   *
   * This queue is created at the app entry point:
   * - Desktop: apps/desktop/src/renderer/create-embedding-queue.ts
   * - Web: apps/web/src/create-embedding-queue.ts
   *
   * The queue is passed down from here to:
   * - ToolsPanel → DatabaseTab → DatabaseDemoPanel (embedding controls and import operations)
   * to ensure all embedding operations use the same queue instance.
   *
   * DO NOT make this prop optional or remove it! It's critical for:
   * - Embedding set management UI
   * - File import embedding generation
   * - Vector search operations
   */
  readonly embeddingQueue?: QueueAdapter | null;
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
  embeddingQueue = null,
}: RootLayoutContentProps): ReactElement {
  const activeTab = usePanelLayoutStore((s) => s.activeTab);
  const setState = usePanelLayoutStore((s) => s.setState);
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  const handleNavigationClick = useCallback(
    (path: string) => {
      setState({ activeTab: resolveActiveTabForPath(path) });
    },
    [setState]
  );

  // CRITICAL: Pass embeddingQueue to ToolsPanel
  // The queue flows:
  // - RootLayoutContent → ToolsPanel → DatabaseTab → DatabaseDemoPanel (embedding controls and import operations)
  const rightPanelContent = useMemo(
    () => <ToolsPanel embeddingQueue={embeddingQueue ?? null} />,
    [embeddingQueue]
  );

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

  const handlePanelLayoutChange = useCallback(
    (state: PanelLayoutState) => {
      setState({
        sizes: [
          (state.sizes?.[0] as number | undefined) ?? panelState.sizes[0],
          (state.sizes?.[1] as number | undefined) ?? panelState.sizes[1],
          (state.sizes?.[2] as number | undefined) ?? panelState.sizes[2],
        ] as [number, number, number],
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
      });
    },
    [setState, panelState.sizes]
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
              consoleContent={<TabbedFileEditorPanel className="h-full" />}
              leftPanelContent={leftPanelContent ?? <FileExplorerLeftPanel />}
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
        {promptsPageContent}
      </div>
      <div
        aria-hidden={activeTab !== 'settings'}
        className={cn('h-full', activeTab !== 'settings' && 'hidden')}
        data-testid="settings-section"
      >
        {settingsPageContent}
      </div>
    </AppLayout>
  );
}
