import { FileExplorerLeftPanel, TabbedFileEditorPanel } from '@brainstrike/file-explorer-ui';
import { IdeLayout } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { isFileExplorerV2Enabled } from './feature-flags';
import { RightPanel } from './right-panel';
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
  const [activeTab, setActiveTab] = useState('explorer');
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  const handleNavigationClick = useCallback((path: string) => {
    const tab = path === '/' ? 'explorer' : 'settings';
    setActiveTab(tab);
  }, []);

  const useV2 = isFileExplorerV2Enabled();
  const sidebarContent = useMemo(
    () => (
      <div
        data-testid={useV2 ? 'explorer-v2-enabled' : 'explorer-v2-disabled'}
        className="h-full min-h-0"
      >
        <FileExplorerLeftPanel useV2={useV2} />
      </div>
    ),
    [useV2]
  );
  const tabbedEditorContent = useMemo(() => <TabbedFileEditorPanel className="h-full" />, []);
  const rightPanelContent = useMemo(() => <RightPanel />, []);

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : '/settings'}
      onNavigationClick={handleNavigationClick}
    >
      <div
        data-testid="explorer-section"
        className={activeTab === 'explorer' ? 'block h-full min-h-0' : 'hidden h-full min-h-0'}
      >
        <IdeLayout
          leftPanelContent={sidebarContent}
          rightPanelContent={rightPanelContent}
          consoleContent={tabbedEditorContent}
        >
          {homePageContent}
        </IdeLayout>
      </div>

      <div
        data-testid="settings-section"
        className={activeTab === 'settings' ? 'block h-full min-h-0' : 'hidden h-full min-h-0'}
      >
        {settingsPageContent}
      </div>
    </AppLayout>
  );
}
