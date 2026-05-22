import { ConnectedPromptManager } from '@brainstrike/app-shell';
import { navigationItems } from '@brainstrike/app-shell/navigation';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { usePGliteDatabase } from '@brainstrike/db';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { type ReactElement, type ReactNode, useCallback, useEffect } from 'react';
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
  useInitializeWebVectorDevicePreference();

  const navigationConfig = navigationItems as NavigationItem[];
  const loadEmbeddingQueue = useCallback(
    () => import('../create-embedding-queue').then((module) => module.getEmbeddingQueue()),
    []
  );
  const loadLocalLlmBackend = useCallback(async () => {
    const { LocalLlmBackend } = await import('@brainstrike/agent/local-llm');
    return new LocalLlmBackend();
  }, []);

  // CRITICAL: loadEmbeddingQueue from create-embedding-queue.ts must be passed through
  // so the queue stays singleton while avoiding startup-time workerpool construction.
  const sharedProps: RootLayoutContentProps = {
    databaseTabChunkingMode: 'local',
    navigationItems: navigationConfig,
    contextExplorerPageContent: <ContextExplorerPageContent />,
    settingsPageContent: <SettingsPageContent />,
    promptsPageContent: <ConnectedPromptManager />,
    loadEmbeddingQueue, // DO NOT REMOVE - See function docstring
    loadLocalLlmBackend,
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return (
    <TokenCacheWrapper>
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
