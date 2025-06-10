import { IdeLayout } from '@brainstrike/ui';
import { Suspense, lazy, useMemo, useState } from 'react';

const FileExplorerLeftPanel = lazy(async () =>
  import('@brainstrike/file-explorer-ui').then((m) => ({ default: m.FileExplorerLeftPanel }))
);
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
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

  const sidebarContent = useMemo(
    () => (
      <Suspense
        fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
      >
        <FileExplorerLeftPanel />
      </Suspense>
    ),
    []
  );

  return (
    <AppLayout
      config={appConfig}
      currentPath={activeTab === 'explorer' ? '/' : '/settings'}
      onNavigationClick={handleNavigationClick}
    >
      <div style={{ display: activeTab === 'explorer' ? 'block' : 'none', height: '100%' }}>
        <IdeLayout
          leftPanelContent={sidebarContent}
          rightPanelContent={
            <div className="p-4 text-sm text-muted-foreground">
              Additional tools and panels will appear here...
            </div>
          }
          consoleContent={
            <div className="p-4 text-sm text-muted-foreground">
              Console output will appear here...
            </div>
          }
        >
          {homePageContent}
        </IdeLayout>
      </div>

      <div style={{ display: activeTab === 'settings' ? 'block' : 'none', height: '100%' }}>
        {settingsPageContent}
      </div>
    </AppLayout>
  );
}
