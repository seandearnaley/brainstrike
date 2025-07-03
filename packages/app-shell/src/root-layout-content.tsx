import { FileExplorerLeftPanel, TabbedFileEditorPanel } from '@brainstrike/file-explorer-ui';
import { IdeLayout } from '@brainstrike/ui';
import { useMemo, useState } from 'react';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
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

  const handleNavigationClick = (path: string) => {
    const tab = path === '/' ? 'explorer' : 'settings';
    setActiveTab(tab);
  };

  const sidebarContent = useMemo(() => <FileExplorerLeftPanel />, []);
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
        className={activeTab === 'explorer' ? 'block h-full' : 'hidden h-full'}
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
        className={activeTab === 'settings' ? 'block h-full' : 'hidden h-full'}
      >
        {settingsPageContent}
      </div>
    </AppLayout>
  );
}
