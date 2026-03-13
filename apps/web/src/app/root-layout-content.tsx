import type { NavigationItem, RootLayoutContentProps } from '@brainstrike/app-shell';
import {
  ConnectedPromptManagerLazy,
  navigationItems,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell';
import { usePGliteDatabase } from '@brainstrike/db';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui';
import { useVectorPreferencesStore } from '@brainstrike/preferences';
import { EmbeddingJobQueueTracker } from '@brainstrike/vector-management';
import { type ReactElement, type ReactNode, Suspense, useCallback, useEffect } from 'react';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

function LazyTabFallback({ testId, text }: { testId: string; text: string }) {
  return (
    <div
      className="flex h-full items-center justify-center text-muted-foreground text-sm"
      data-testid={testId}
    >
      {text}
    </div>
  );
}

/**
 * Wrapper component that provides TokenCacheProvider.
 * The provider now renders children even while the database/worker pool finish
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

function useInitializeWebVectorDevicePreference(): void {
  const devicePrefConfigured = useVectorPreferencesStore((state) => state.devicePrefConfigured);
  const devicePref = useVectorPreferencesStore((state) => state.devicePref);
  const setDetectedDevicePref = useVectorPreferencesStore((state) => state.setDetectedDevicePref);

  useEffect(() => {
    if (devicePrefConfigured || devicePref === 'wasm') {
      return;
    }
    setDetectedDevicePref('wasm');
  }, [devicePref, devicePrefConfigured, setDetectedDevicePref]);
}

/**
 * Web app root layout component.
 *
 * CRITICAL: This component creates the embedding queue flow for the entire app:
 *
 * 1. create-embedding-queue.ts is resolved lazily when DB/vector tooling needs it
 * 2. Passed to SharedRootLayoutContent as loadEmbeddingQueue prop
 * 3. Flows through:
 *    - RootLayoutContent → ToolsPanel → VectorsTab → VectorStatusWithDialog
 *    - RootLayoutContent → ToolsPanel → DatabaseTab → DatabaseDemoPanel (import operations)
 * 4. VectorStatusWithDialog uses it for embedding set management and operations
 *
 * DO NOT remove the loadEmbeddingQueue prop! It's the single source of truth for all
 * embedding operations in the web app.
 *
 * TOKEN CACHE: The TokenCacheWrapper provides a shared token cache context that
 * enables background token indexing. It wraps the entire layout so both:
 * - FileExplorerLeftPanel (indexes selected files via background worker)
 * - PreviewPanel in HomePageContent (displays token counts from the shared cache)
 * can share the same context and see each other's updates.
 */
export default function RootLayoutContent() {
  useInitializeWebVectorDevicePreference();

  const navigationConfig = navigationItems as NavigationItem[];
  const loadEmbeddingQueue = useCallback(
    () =>
      import('../create-embedding-queue').then((module) => {
        return module.embeddingQueue;
      }),
    []
  );

  // CRITICAL: loadEmbeddingQueue from create-embedding-queue.ts must be passed through
  // so the queue stays singleton while avoiding startup-time workerpool construction.
  const sharedProps: RootLayoutContentProps = {
    databaseTabChunkingMode: 'local',
    navigationItems: navigationConfig,
    homePageContent: <HomePageContent />,
    settingsPageContent: <SettingsPageContent />,
    promptsPageContent: (
      <Suspense
        fallback={<LazyTabFallback testId="web-prompts-page-loading" text="Loading prompts…" />}
      >
        <ConnectedPromptManagerLazy />
      </Suspense>
    ),
    loadEmbeddingQueue, // DO NOT REMOVE - See function docstring
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return (
    <TokenCacheWrapper>
      <EmbeddingJobQueueTracker />
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
