import {
  RootLayoutContent as SharedRootLayoutContent,
  navigationItems,
} from '@brainstrike/app-shell';
import HomePageContent, { DesktopFileExplorerLeftPanel } from './home-page-content';
import SettingsPageContent from './settings/page-content';

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
