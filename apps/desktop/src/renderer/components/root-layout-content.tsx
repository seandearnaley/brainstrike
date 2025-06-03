import { RootLayoutContent as SharedRootLayoutContent } from '@brainstrike/app-shell';
import { Folder, Settings } from 'lucide-react';
import HomePageContent, { DesktopFileExplorerLeftPanel } from './home-page-content';
import SettingsPageContent from './settings/page-content';

const navigationItems = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];

export default function RootLayoutContent() {
  return (
    <SharedRootLayoutContent
      navigationItems={navigationItems}
      sidebarContent={<DesktopFileExplorerLeftPanel />}
      homePageContent={<HomePageContent />}
      settingsPageContent={<SettingsPageContent />}
    />
  );
}
