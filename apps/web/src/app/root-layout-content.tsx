import { ConnectedPromptManager } from '@brainstrike/app-shell';
import { navigationItems } from '@brainstrike/app-shell/navigation';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { usePGliteDatabase } from '@brainstrike/db';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
import { ensureBackgroundIndexingPreferencesHydrated } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { ensureVectorPreferencesHydrated } from '@brainstrike/preferences/stores/vector-preferences-store';
import { type ReactElement, type ReactNode, useCallback, useEffect } from 'react';
import { getEmbeddingQueue, registerWebEmbeddingRuntimeConfig } from '../create-embedding-queue';
import ContextExplorerPageContent from './context-explorer-page-content';
import SettingsPageContent from './settings/page-content';

/**
 * Wrapper component that provides TokenCacheProvider.
 * The token worker must be ready eagerly so background indexing starts immediately.
 */
function TokenCacheWrapper({ children }: { children: ReactNode }) {
  const db = usePGliteDatabase();
  return <TokenCacheProvider db={db}>{children}</TokenCacheProvider>;
}

/**
 * Web app root layout component.
 *
 * CRITICAL: This component creates the embedding queue flow for the entire app:
 *
 * 1. create-embedding-queue.ts is resolved lazily when DB/vector tooling needs it
 * 2. Passed to SharedRootLayoutContent as loadEmbeddingQueue prop
 * 3. Flows through RootLayoutContent → AgentSidebarPanel → DatabasePanel → DatabaseTab → DatabaseDemoPanel
 * 4. Database-facing views use it for embedding set management and import operations
 *
 * DO NOT remove the loadEmbeddingQueue prop! It's the single source of truth for all
 * embedding operations in the web app.
 *
 * TOKEN CACHE: The TokenCacheWrapper provides a shared token cache context that
 * enables background token indexing. It wraps the entire layout so both:
 * - FileExplorerPanel (indexes selected files via background worker)
 * - PreviewPanel in ContextExplorerPageContent (displays token counts from the shared cache)
 * can share the same context and see each other's updates.
 */
export default function RootLayoutContent() {
  const navigationConfig = navigationItems as NavigationItem[];
  const loadEmbeddingQueue = useCallback(async () => getEmbeddingQueue(), []);
  const loadLocalLlmBackend = useCallback(async () => {
    const { LocalLlmBackend } = await import('@brainstrike/agent/local-llm');
    return new LocalLlmBackend();
  }, []);

  useEffect(() => {
    let errorTimer: ReturnType<typeof setTimeout> | null = null;
    void Promise.all([
      Promise.resolve(registerWebEmbeddingRuntimeConfig()),
      ensureBackgroundIndexingPreferencesHydrated(),
      ensureVectorPreferencesHydrated(),
    ]).catch((error: unknown) => {
      errorTimer = setTimeout(() => {
        throw error;
      }, 0);
    });
    return () => {
      if (errorTimer) {
        clearTimeout(errorTimer);
      }
    };
  }, []);

  // CRITICAL: loadEmbeddingQueue from create-embedding-queue.ts must be passed through
  // so the queue stays singleton while avoiding startup-time workerpool construction.
  const sharedProps: RootLayoutContentProps = {
    contextExplorerPageContent: <ContextExplorerPageContent />,
    databaseTabChunkingMode: 'local',
    loadEmbeddingQueue, // DO NOT REMOVE - See function docstring
    loadLocalLlmBackend,
    navigationItems: navigationConfig,
    promptsPageContent: <ConnectedPromptManager />,
    settingsPageContent: <SettingsPageContent />,
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return (
    <TokenCacheWrapper>
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
