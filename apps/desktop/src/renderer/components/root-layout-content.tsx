import type { NavigationItem, RootLayoutContentProps } from '@brainstrike/app-shell';
import {
  ConnectedPromptManager,
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import { usePGliteDatabase } from '@brainstrike/db';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui';
import type { QueueAdapter } from '@brainstrike/queue';
import { EmbeddingJobQueueTracker } from '@brainstrike/vector-management';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

/**
 * Wrapper component that provides TokenCacheProvider.
 * The provider keeps children mounted while the database/worker pool finish
 * initializing so the UI never unmounts during startup.
 */
function TokenCacheWrapper({ children }: { children: ReactNode }) {
  const db = usePGliteDatabase();
  return (
    <TokenCacheProvider db={db} lazyWorkerInit={true}>
      {children}
    </TokenCacheProvider>
  );
}

/**
 * Desktop app root layout component.
 *
 * CRITICAL: This component creates the embedding queue flow for the entire app:
 *
 * 1. embeddingQueue is imported from create-embedding-queue.ts (createElectronEmbeddingQueue)
 * 2. Passed to SharedRootLayoutContent as embeddingQueue prop
 * 3. Flows through:
 *    - RootLayoutContent → ToolsPanel → VectorsTab → VectorStatusWithDialog
 *    - RootLayoutContent → ToolsPanel → DatabaseTab → DatabaseDemoPanel (import operations)
 * 4. VectorStatusWithDialog uses it for embedding set management and operations
 *
 * DO NOT remove the embeddingQueue prop! It's the single source of truth for all
 * embedding operations in the desktop app.
 *
 * TOKEN CACHE: The TokenCacheWrapper provides a shared token cache context that
 * enables background token indexing. It wraps the entire layout so both:
 * - FileExplorerLeftPanel (indexes selected files via background worker)
 * - PreviewPanel in HomePageContent (displays token counts from the shared cache)
 * can share the same context and see each other's updates.
 */
export default function RootLayoutContent() {
  const navigationConfig = navigationItems as NavigationItem[];
  const [embeddingQueue, setEmbeddingQueue] = useState<QueueAdapter | null>(null);
  const [queueLoadError, setQueueLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    import('../create-embedding-queue')
      .then((module) => {
        if (!cancelled) {
          setEmbeddingQueue(module.embeddingQueue);
          setQueueLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQueueLoadError(
            error instanceof Error
              ? error
              : new Error('Failed to load the desktop embedding queue.')
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (queueLoadError) {
    throw queueLoadError;
  }

  // CRITICAL: embeddingQueue from create-embedding-queue.ts must be passed through
  // once the queue module finishes loading. This remains the app's single queue instance.
  const sharedProps: RootLayoutContentProps = {
    navigationItems: navigationConfig,
    homePageContent: <HomePageContent />,
    settingsPageContent: <SettingsPageContent />,
    promptsPageContent: <ConnectedPromptManager />,
    embeddingQueue, // DO NOT REMOVE - See function docstring
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return (
    <TokenCacheWrapper>
      <EmbeddingJobQueueTracker />
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
