import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import { Folder, Settings } from 'lucide-react';
import { useState } from 'react';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

const appConfig = createAppConfig({
  navigationItems: [
    { name: 'Context Explorer', icon: Folder, path: '/' },
    { name: 'Settings', icon: Settings, path: '/settings' },
  ],
});

export default function RootLayoutContent() {
  const [activeTab, setActiveTab] = useState<'explorer' | 'settings'>('explorer');

  const handleNavigationClick = (path: string) => {
    if (path === '/') {
      setActiveTab('explorer');
    } else if (path === '/settings') {
      setActiveTab('settings');
    }
  };

  return (
    <div className="h-screen">
      <AppLayout
        config={appConfig}
        currentPath={activeTab === 'explorer' ? '/' : '/settings'}
        onNavigationClick={handleNavigationClick}
      >
        {/* Keep both components mounted to preserve state */}
        <div style={{ display: activeTab === 'explorer' ? 'block' : 'none' }}>
          <HomePageContent />
        </div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
          <SettingsPageContent />
        </div>
      </AppLayout>
    </div>
  );
}
