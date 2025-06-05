import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
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

  const appConfig = useMemo(() => createAppConfig({ navigationItems }), [navigationItems]);

  return (
    <FileExplorerProvider storageAdapter={storageAdapter}>
      <AppLayout
        config={appConfig}
        currentPath={activeTab === 'explorer' ? '/' : '/settings'}
        onNavigationClick={handleNavigationClick}
        sidebarContent={
          sidebarContent && (
            <div
              className="h-full w-full"
              style={{ display: activeTab === 'explorer' ? 'block' : 'none' }}
            >
              {sidebarContent}
            </div>
          )
        }
      >
        <div className="h-full" style={{ position: 'relative', overflow: 'hidden' }}>
          <div
            className="h-full"
            style={{
              display: activeTab === 'explorer' ? 'block' : 'none',
              position: 'relative',
              width: '100%',
              height: '100%',
            }}
          >
            {homePageContent}
          </div>
          <div
            className="h-full"
            style={{
              display: activeTab === 'settings' ? 'block' : 'none',
              position: 'relative',
              width: '100%',
              height: '100%',
            }}
          >
            {settingsPageContent}
          </div>
        </div>
      </AppLayout>
    </FileExplorerProvider>
  );
}
