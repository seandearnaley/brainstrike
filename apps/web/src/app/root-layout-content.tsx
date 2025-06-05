import {
  RootLayoutContent as SharedRootLayoutContent,
  navigationItems,
} from '@brainstrike/app-shell';
import HomePageContent, { WebFileExplorerLeftPanel } from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  return (
    <SharedRootLayoutContent
      navigationItems={navigationItems}
      sidebarContent={<WebFileExplorerLeftPanel />}
      homePageContent={<HomePageContent />}
      settingsPageContent={<SettingsPageContent />}
    />
  );
}
