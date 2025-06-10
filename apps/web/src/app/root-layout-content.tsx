import {
  RootLayoutContent as SharedRootLayoutContent,
  navigationItems,
} from '@brainstrike/app-shell';
import { Suspense, lazy } from 'react';

const HomePageContent = lazy(() => import('./home-page-content'));
const SettingsPageContent = lazy(() => import('./settings/page-content'));

export default function RootLayoutContent() {
  return (
    <SharedRootLayoutContent
      navigationItems={navigationItems}
      homePageContent={
        <Suspense
          fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
        >
          <HomePageContent />
        </Suspense>
      }
      settingsPageContent={
        <Suspense
          fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
        >
          <SettingsPageContent />
        </Suspense>
      }
    />
  );
}
