import type { NavigationItem, RootLayoutContentProps } from '@brainstrike/app-shell';
import {
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import type { ReactElement } from 'react';
import { embeddingQueue } from '../create-embedding-queue';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

export default function RootLayoutContent() {
  const navigationConfig = navigationItems as NavigationItem[];
  const sharedProps: RootLayoutContentProps = {
    navigationItems: navigationConfig,
    homePageContent: <HomePageContent />,
    settingsPageContent: <SettingsPageContent />,
    embeddingQueue,
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return <RootLayout {...sharedProps} />;
}
