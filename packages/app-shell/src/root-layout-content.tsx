import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { type ReactNode, useCallback, useState } from 'react';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import type { NavigationItem } from './types';

export interface RootLayoutContentProps {
  sidebarContent?: ReactNode;
  navigationItems: NavigationItem[];
  homePageContent: ReactNode;
  settingsPageContent: ReactNode;
}

export function RootLayoutContent({
  sidebarContent,
  navigationItems,
  homePageContent,
  settingsPageContent,
}: RootLayoutContentProps) {
  const [activeTab, setActiveTab] = useState<'explorer' | 'settings'>('explorer');
  const { storageAdapter } = useAdapters();

  const handleNavigationClick = useCallback((path: string) => {
    if (path === '/') {
      setActiveTab('explorer');
    } else if (path === '/settings') {
      setActiveTab('settings');
    }
  }, []);

  const appConfig = createAppConfig({ navigationItems });

  return (
    <FileExplorerProvider storageAdapter={storageAdapter}>
      <AppLayout
        config={appConfig}
        currentPath={activeTab === 'explorer' ? '/' : '/settings'}
        onNavigationClick={handleNavigationClick}
        sidebarContent={activeTab === 'explorer' ? sidebarContent : undefined}
      >
        <div className="h-full" style={{ position: 'relative', overflow: 'hidden' }}>
          <div
            className="h-full"
            style={{
              visibility: activeTab === 'explorer' ? 'visible' : 'hidden',
              position: activeTab === 'explorer' ? 'relative' : 'absolute',
              width: '100%',
              height: '100%',
              pointerEvents: activeTab === 'explorer' ? 'auto' : 'none',
            }}
          >
            {homePageContent}
          </div>
          <div
            className="h-full"
            style={{
              visibility: activeTab === 'settings' ? 'visible' : 'hidden',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              pointerEvents: activeTab === 'settings' ? 'auto' : 'none',
            }}
          >
            {settingsPageContent}
          </div>
        </div>
      </AppLayout>
    </FileExplorerProvider>
  );
}
