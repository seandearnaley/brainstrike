import {
  RootLayoutContent as SharedRootLayoutContent,
  navigationItems,
} from '@brainstrike/app-shell';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  return (
    <SharedRootLayoutContent
      navigationItems={navigationItems}
      homePageContent={<HomePageContent />}
      settingsPageContent={<SettingsPageContent />}
    />
  );
}
