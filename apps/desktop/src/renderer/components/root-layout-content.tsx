import {
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import { embeddingQueue } from '../create-embedding-queue';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  return (
    <SharedRootLayoutContent
      navigationItems={navigationItems}
      homePageContent={<HomePageContent />}
      settingsPageContent={<SettingsPageContent />}
      embeddingQueue={embeddingQueue}
    />
  );
}
