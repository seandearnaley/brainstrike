import {
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import { CustomTitlebar } from '@brainstrike/ui';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  return (
    <div className="h-screen flex flex-col">
      <CustomTitlebar title="BrainStrike" />
      <div className="flex-1 overflow-hidden">
        <SharedRootLayoutContent
          navigationItems={navigationItems}
          homePageContent={<HomePageContent />}
          settingsPageContent={<SettingsPageContent />}
        />
      </div>
    </div>
  );
}
