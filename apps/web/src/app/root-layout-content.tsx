import { navigationItems } from '@brainstrike/app-shell/navigation';
import NotesPageContent from '@brainstrike/app-shell/notes-page-content';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { useDocumentTitle } from '@brainstrike/app-shell/use-document-title';
import { ensureBackgroundIndexingPreferencesHydrated } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { ensureVectorPreferencesHydrated } from '@brainstrike/app-state/stores/vector-preferences-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
// Capability check from the dependency-light `availability` subpath (NOT
// `/panel`) so the startup check does not defeat the lazy code-split in
// `@brainstrike/app-shell/notes-page-content`.
import { isNotesVaultAvailable } from '@brainstrike/notes-vault/availability';
import { NotebookPen } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { getEmbeddingQueue, registerWebEmbeddingRuntimeConfig } from '../create-embedding-queue';
import { loadLocalLlmBackend } from '../load-local-llm-backend';
import ContextExplorerPageContent from './context-explorer-page-content';
import SettingsPageContent from './settings/page-content';

const NOTES_NAVIGATION_ITEM: NavigationItem = { icon: NotebookPen, name: 'Notes', path: '/notes' };

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
 *
 * DOCUMENT TITLE: this is the web app's single mount point, so it is where the
 * one and only `useDocumentTitle` writer lives (BST-1281). Nothing below it may
 * write `document.title` or `<meta name="description">`.
 */
export default function RootLayoutContent() {
  useDocumentTitle();
  // Capability gate: only surface the Notes tab when the File System Access
  // directory picker exists (Chromium; Safari/Firefox omit it). Resolved once.
  const notesAvailable = useMemo(() => isNotesVaultAvailable(), []);
  const navigationConfig = useMemo<NavigationItem[]>(() => {
    const items = [...navigationItems];
    if (notesAvailable) {
      items.push(NOTES_NAVIGATION_ITEM);
    }
    return items;
  }, [notesAvailable]);
  const loadEmbeddingQueue = useCallback(async () => getEmbeddingQueue(), []);

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
    // Canvas surface (BST-1173) deliberately OMITTED on web: nothing can WRITE
    // a canvas here — manageCanvas is desktop-only (WebNativeToolId) and the
    // agent host owns every canvas. A permanently-empty tab would violate the
    // capability convention (omit, don't stub). The render tier stays web-capable
    // (CanvasFrame + /canvas-frame.html serving are live), so wiring
    // `canvasPanelContent` back is one line once web gains a write path.
    contextExplorerPageContent: <ContextExplorerPageContent />,
    databaseTabChunkingMode: 'local',
    loadEmbeddingQueue, // DO NOT REMOVE - See function docstring
    loadLocalLlmBackend,
    navigationItems: navigationConfig,
    settingsPageContent: <SettingsPageContent />,
    ...(notesAvailable ? { notesPageContent: <NotesPageContent /> } : {}),
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  return (
    <TokenCacheWrapper>
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
