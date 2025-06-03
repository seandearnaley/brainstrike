import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { Folder, Settings } from 'lucide-react';
import { useState } from 'react';
import HomePageContent, { WebFileExplorerLeftPanel } from './home-page-content';
import SettingsPageContent from './settings/page-content';

const appConfig = createAppConfig({
  navigationItems: [
    { name: 'Context Explorer', icon: Folder, path: '/' },
    { name: 'Settings', icon: Settings, path: '/settings' },
  ],
});

export default function RootLayoutContent() {
  const [activeTab, setActiveTab] = useState<'explorer' | 'settings'>('explorer');
  const { storageAdapter } = useAdapters();

  const handleNavigationClick = (path: string) => {
    if (path === '/') {
      setActiveTab('explorer');
    } else if (path === '/settings') {
      setActiveTab('settings');
    }
  };

  return (
    <FileExplorerProvider storageAdapter={storageAdapter}>
      <AppLayout
        config={appConfig}
        currentPath={activeTab === 'explorer' ? '/' : '/settings'}
        onNavigationClick={handleNavigationClick}
        sidebarContent={activeTab === 'explorer' ? <WebFileExplorerLeftPanel /> : undefined}
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
            <HomePageContent />
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
            <SettingsPageContent />
          </div>
        </div>
      </AppLayout>
    </FileExplorerProvider>
  );
}
