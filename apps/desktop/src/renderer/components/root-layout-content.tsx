import {
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import { ElectronPanelPersistenceAdapter, PanelLayoutProvider } from '@brainstrike/ui';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  return (
    <PanelLayoutProvider
      initialState={{
        sizes: [25, 55, 20],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      }}
      adapter={new ElectronPanelPersistenceAdapter()}
    >
      <SharedRootLayoutContent
        navigationItems={navigationItems}
        homePageContent={<HomePageContent />}
        settingsPageContent={<SettingsPageContent />}
      />
    </PanelLayoutProvider>
  );
}
