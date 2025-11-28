import type { NavigationItem, RootLayoutContentProps } from '@brainstrike/app-shell';
import {
  ConnectedPromptManager,
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import type { ReactElement } from 'react';
import { embeddingQueue } from '../create-embedding-queue';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

/**
 * Web app root layout component.
 *
 * CRITICAL: This component creates the embedding queue flow for the entire app:
 *
 * 1. embeddingQueue is imported from create-embedding-queue.ts (createBrowserEmbeddingQueue)
 * 2. Passed to SharedRootLayoutContent as embeddingQueue prop
 * 3. Flows through: RootLayoutContent → RightPanel → DatabaseTab → VectorStatusWithDialog
 * 4. VectorStatusWithDialog uses it for embedding set management and operations
 *
 * DO NOT remove the embeddingQueue prop! It's the single source of truth for all
 * embedding operations in the web app.
 */
export default function RootLayoutContent() {
  const navigationConfig = navigationItems as NavigationItem[];

  // CRITICAL: embeddingQueue from create-embedding-queue.ts must be passed through
  // This is the app's embedding queue instance that all components share
  const sharedProps: RootLayoutContentProps = {
    navigationItems: navigationConfig,
    homePageContent: <HomePageContent />,
    settingsPageContent: <SettingsPageContent />,
    promptsPageContent: <ConnectedPromptManager />,
    embeddingQueue, // DO NOT REMOVE - See function docstring
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return <RootLayout {...sharedProps} />;
}
