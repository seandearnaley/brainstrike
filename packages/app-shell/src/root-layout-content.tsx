import { FileExplorerLeftPanel, TabbedFileEditorPanel } from '@brainstrike/file-explorer-ui';
import type { QueueAdapter } from '@brainstrike/queue';
import { cn, IdeLayout, PanelLayoutProvider } from '@brainstrike/ui';
import { type ReactElement, type ReactNode, useCallback, useMemo } from 'react';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { RightPanel } from './right-panel';
import { usePanelLayoutStore } from './stores/panel-layout-store';
import type { NavigationItem } from './types';

export type RootLayoutContentProps = {
  readonly homePageContent: ReactNode;
  readonly settingsPageContent: ReactNode;
  readonly promptsPageContent?: ReactNode;
  readonly navigationItems: NavigationItem[];

  /**
   * CRITICAL: The app-specific embedding queue adapter.
   *
   * This queue is created at the app entry point:
   * - Desktop: apps/desktop/src/renderer/create-embedding-queue.ts
   * - Web: apps/web/src/create-embedding-queue.ts
   *
   * The queue is passed down from here to RightPanel → DatabaseTab → VectorStatusWithDialog
   * to ensure all embedding operations use the same queue instance.
   *
   * DO NOT make this prop optional or remove it! It's critical for:
   * - Embedding set management UI
   * - File import embedding generation
   * - Vector search operations
   */
  readonly embeddingQueue?: QueueAdapter | null;
};

export function RootLayoutContent({
  homePageContent,
  settingsPageContent,
  promptsPageContent,
  navigationItems,
  embeddingQueue = null,
}: RootLayoutContentProps): ReactElement {
  const activeTab = usePanelLayoutStore((s) => s.activeTab);
  const setState = usePanelLayoutStore((s) => s.setState);
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  const handleNavigationClick = useCallback(
    (path: string) => {
      let tab = 'explorer';
      if (path === '/settings') {
        tab = 'settings';
      } else if (path === '/prompts') {
        tab = 'prompts';
      }

      setState({ activeTab: tab as 'explorer' | 'settings' | 'prompts' });
    },
    [setState]
  );

  // CRITICAL: Pass embeddingQueue to RightPanel
  // The queue flows: RootLayoutContent → RightPanel → DatabaseTab → VectorStatusWithDialog
  const rightPanelContent = useMemo(
    () => <RightPanel embeddingQueue={embeddingQueue ?? null} />,
    [embeddingQueue]
  );

  // Controlled panel layout state from store
  const panelState = usePanelLayoutStore((s) => ({
    sizes: s.sizes,
    showConsole: s.showConsole,
    showLeftPanel: s.showLeftPanel,
    showRightPanel: s.showRightPanel,
  }));

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
        <PanelLayoutProvider
          controlledState={panelState}
          onChange={(state) => {
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
          }}
        >
          <IdeLayout
            consoleContent={<TabbedFileEditorPanel className="h-full" />}
            leftPanelContent={<FileExplorerLeftPanel />}
            rightPanelContent={rightPanelContent}
          >
            {homePageContent}
          </IdeLayout>
        </PanelLayoutProvider>
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
