import {
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  const Component = SharedRootLayoutContent as React.ComponentType<{
    navigationItems: unknown;
    homePageContent: React.ReactNode;
    settingsPageContent: React.ReactNode;
  }>;

  return (
    <Component
      navigationItems={navigationItems}
      homePageContent={<HomePageContent />}
      settingsPageContent={<SettingsPageContent />}
    />
  );
}
