import { FileExplorerLeftPanel, TabbedFileEditorPanel } from '@brainstrike/file-explorer-ui';
import { IdeLayout, PanelLayoutProvider } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { RightPanel } from './right-panel';
import { usePanelLayoutStore } from './stores/panel-layout-store';
import type { NavigationItem } from './types';

export function RootLayoutContent({
  homePageContent,
  settingsPageContent,
  navigationItems,
}: {
  homePageContent: React.ReactNode;
  settingsPageContent: React.ReactNode;
  navigationItems: NavigationItem[];
}) {
  const activeTab = usePanelLayoutStore((s) => s.activeTab);
  const setState = usePanelLayoutStore((s) => s.setState);
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  const handleNavigationClick = useCallback(
    (path: string) => {
      const tab = path === '/' ? 'explorer' : 'settings';
      setState({ activeTab: tab as 'explorer' | 'settings' });
    },
    [setState]
  );

  const sidebarContent = useMemo(() => <FileExplorerLeftPanel />, []);
  const tabbedEditorContent = useMemo(() => <TabbedFileEditorPanel className="h-full" />, []);
  const rightPanelContent = useMemo(() => <RightPanel />, []);

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
      currentPath={activeTab === 'explorer' ? '/' : '/settings'}
      onNavigationClick={handleNavigationClick}
    >
      {activeTab === 'explorer' ? (
        <div data-testid="explorer-section" className="h-full">
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
              leftPanelContent={sidebarContent}
              rightPanelContent={rightPanelContent}
              consoleContent={tabbedEditorContent}
            >
              {homePageContent}
            </IdeLayout>
          </PanelLayoutProvider>
        </div>
      ) : (
        <div data-testid="settings-section" className="h-full">
          {settingsPageContent}
        </div>
      )}
    </AppLayout>
  );
}
