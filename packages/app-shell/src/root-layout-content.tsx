import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import { type DbHandle, usePGliteDatabase } from '@brainstrike/db';
import { MarkdownPreviewCapabilitiesProvider } from '@brainstrike/file-explorer-ui';
import { RootDataDeletionProvider, useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { FileTreeProvider } from '@brainstrike/file-explorer-ui/tree';
import { ChunkingWorkerProvider } from '@brainstrike/file-import/chunking-worker-context';
import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/preferences/stores/panel-layout-store';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  ActionRegistryProvider,
  Dialog,
  DialogContent,
  DialogTitle,
  IdeLayout,
  PanelLayoutProvider,
  type PanelLayoutState,
} from '@brainstrike/ui';
import {
  EmbeddingRuntimeProvider,
  IndexingActivityCoordinator,
  SearchEmbedderProvider,
} from '@brainstrike/vector-management';
import {
  memo,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shallow } from 'zustand/shallow';
import { AgentSidebarPanel } from './agent-sidebar-panel';
import { AgentWorkspaceLayout } from './agent-workspace-layout';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { AssistantChatPanel } from './assistant-chat-panel';
import { WorkspaceCollectionSyncProvider } from './background-indexing/workspace-collection-sync-provider';
import { CommandPaletteHost } from './command-palette-host';
import { ConnectedPromptManagerLazy } from './connected-prompt-manager-lazy';
import { createAppActionRegistry } from './context-action-registry';
import { DatabasePanel } from './database-panel';
import { ExplorerSearchTabs } from './explorer-search-tabs';
import { QuickOpenHost } from './quick-open-host';
import { ThreadsPanel } from './threads-panel';
import type { NavigationItem } from './types';
import { useMarkdownPreviewCapabilitiesValue } from './use-markdown-preview-capabilities';
// Side-effect: register session-only stores with the factory-reset pipeline.
import './register-factory-reset-session-stores';

interface DebouncedPanelLayoutState {
  readonly showConsole: boolean;
  readonly showLeftPanel: boolean;
  readonly showRightPanel: boolean;
  readonly sizes: [number, number, number];
}

/**
 * Reads the affected-row count from a DML query result across driver shapes:
 * PGlite populates `affectedRows`; node-pg-style bridges use `rowCount`.
 * Returns `null` when neither is present so callers can distinguish
 * "positively zero rows" from "the driver did not report a count" and avoid a
 * false abort on a bridge that strips the field.
 */
function readAffectedRows(result: unknown): number | null {
  const shaped = result as { affectedRows?: unknown; rowCount?: unknown };
  if (typeof shaped.affectedRows === 'number') {
    return shaped.affectedRows;
  }
  if (typeof shaped.rowCount === 'number') {
    return shaped.rowCount;
  }
  return null;
}

/**
 * Deletes a root's `roots` row (cascading file_records + chunks via migration
 * 039's ON DELETE CASCADE). `roots.id` is a uuidv7, but the disconnect flow
 * passes a path as the id for legacy/unregistered roots (the sidebar falls
 * back to `handle.path` when `rootIdByPath` has no entry), so the row must be
 * matched by `id` OR `path` — `path` is uniquely indexed. A delete that
 * positively affects zero rows THROWS: the seam's contract is "never a silent
 * no-op", so an unconfirmed delete must abort the disconnect rather than let
 * the user believe data was removed while UUID-keyed rows survive.
 */
export async function deleteRootDataFromDb(db: DbHandle, rootIdOrPath: string): Promise<void> {
  const result = await db.query('DELETE FROM roots WHERE id = $1 OR path = $1', [rootIdOrPath]);
  if (readAffectedRows(result) === 0) {
    throw new Error(
      `Root data deletion matched no rows for "${rootIdOrPath}" — refusing to report a silent success.`
    );
  }
}

function FileTreeWrapper({ children }: { children: ReactNode }): ReactElement {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  // Storage v5: pass the durable RootId so the FileTreeProvider keys its index
  // and stamps IFileNode.rootFolderId with the UUID instead of the handle path.
  // Prefer the stamped handle.rootId — the path→id map collides for same-named
  // web roots (it keeps only the last), so it cannot identify the focused one.
  const rootId = rootDirectoryHandle
    ? (rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path))
    : undefined;
  const db = usePGliteDatabase();
  // Cascade-delete seam (Phase 6): file-explorer-ui doesn't own the db, so
  // app-shell injects the deletion. Migration 039: file_records.root_id →
  // roots.id ON DELETE CASCADE; chunks cascade from file_records. MUST throw
  // on failure — the disconnect flow aborts and keeps the root connected.
  const deleteRootData = useCallback(
    async (rootIdToDelete: string) => {
      if (!db) {
        throw new Error('Cannot delete root data: database is not ready.');
      }
      await deleteRootDataFromDb(db, rootIdToDelete);
    },
    [db]
  );
  return (
    <FileTreeProvider
      rootDirectoryHandle={rootDirectoryHandle}
      {...(rootId !== undefined && { rootId })}
    >
      <RootDataDeletionProvider deleteRootData={deleteRootData}>
        <WorkspaceCollectionSyncProvider>{children}</WorkspaceCollectionSyncProvider>
      </RootDataDeletionProvider>
    </FileTreeProvider>
  );
}

export interface RootLayoutContentProps {
  readonly contextExplorerPageContent: ReactNode;
  readonly contextExplorerPanelContent?: ReactNode;
  readonly databaseTabChunkingMode?: 'host-proxy' | 'local';
  /**
   * CRITICAL: Lazy loader for the app-specific embedding queue adapter.
   *
   * This loader is the single source of truth for app-wide database tooling:
   * RootLayoutContent → AgentSidebarPanel → DatabasePanel → DatabaseTab → DatabaseDemoPanel.
   */
  /**
   * Optional Git surface (desktop-only). Supplied by the desktop wrapper when
   * the `window.git` bridge is present; web never constructs it (capability
   * gating, not an isElectron check). When absent, no Git nav item is rendered.
   */
  readonly gitPageContent?: ReactNode;
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
  readonly navigationItems: NavigationItem[];
  /**
   * Optional markdown notes vault surface. Supplied by app wrappers when the
   * File System Access directory picker capability exists (Chromium web,
   * Electron renderers); Safari/Firefox never construct it (capability
   * gating, not UA sniffing). When absent, no Notes nav item is rendered.
   */
  readonly notesPageContent?: ReactNode;
  readonly preloadDatabaseTabOnMount?: boolean;
  readonly settingsPageContent: ReactNode;
  /**
   * Optional Terminal surface (desktop-only). Supplied by the desktop wrapper
   * when the `window.terminal` bridge is present; web never constructs it
   * (capability gating, not an isElectron check). When absent, no Terminal nav
   * item is rendered.
   */
  readonly terminalPageContent?: ReactNode;
}

const NAV_PATH_TO_TAB: Record<string, PanelTab> = {
  '/git': 'git',
  '/notes': 'notes',
  '/settings': 'settings',
  '/terminal': 'terminal',
};

function resolveActiveTabForPath(path: string): PanelTab {
  return NAV_PATH_TO_TAB[path] ?? 'explorer';
}

function useDebouncedPanelLayoutChange(options: {
  readonly panelState: DebouncedPanelLayoutState;
  readonly setState: (next: DebouncedPanelLayoutState) => void;
}) {
  const { panelState, setState } = options;
  const panelStateRef = useRef(panelState);
  const setStateRef = useRef(setState);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  panelStateRef.current = panelState;
  setStateRef.current = setState;

  const cleanupSizeDebounce = useCallback(() => {
    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
  }, []);

  useEffect(() => cleanupSizeDebounce, [cleanupSizeDebounce]);

  // Stable callback: all mutable panel state flows through refs so resize commits
  // do not recreate the outer or inner layout trees.
  return useCallback((state: PanelLayoutState) => {
    const currentPanelState = panelStateRef.current;
    const fallback = currentPanelState.sizes;
    const nextSizes = [
      (state.sizes?.[0] as number | undefined) ?? fallback[0],
      (state.sizes?.[1] as number | undefined) ?? fallback[1],
      (state.sizes?.[2] as number | undefined) ?? fallback[2],
    ] as [number, number, number];

    const booleansChanged =
      state.showConsole !== currentPanelState.showConsole ||
      state.showLeftPanel !== currentPanelState.showLeftPanel ||
      state.showRightPanel !== currentPanelState.showRightPanel;

    if (booleansChanged) {
      if (sizeDebounceRef.current) {
        clearTimeout(sizeDebounceRef.current);
        sizeDebounceRef.current = null;
      }
      setStateRef.current({
        ...currentPanelState,
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
        sizes: nextSizes,
      });
      return;
    }

    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
    sizeDebounceRef.current = setTimeout(() => {
      sizeDebounceRef.current = null;
      setStateRef.current({
        ...currentPanelState,
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
        sizes: nextSizes,
      });
    }, 150);
  }, []);
}

const EXPLORER_RIGHT_PANEL_CHROME = {
  hideButtonLabel: 'Hide explorer panel',
  hideButtonTestId: 'hide-explorer-panel',
  showButtonLabel: 'Show explorer panel',
  showButtonTestId: 'show-explorer-panel',
  title: 'Explorer',
} as const;

const CONTEXT_EXPLORER_PANEL_CONSTRAINTS = {
  mainContentMinSize: '20%',
  rightPanelMinSize: '180px',
} as const;

function ContextExplorerSurface({
  contextExplorerPanelContent,
  contextExplorerPageContent,
}: {
  readonly contextExplorerPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
}): ReactElement {
  const setState = useContextExplorerLayoutStore((state) => state.setState);
  const panelState = useContextExplorerLayoutStore(
    (state) => ({
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      sizes: state.sizes,
    }),
    shallow
  );
  const handlePanelLayoutChange = useDebouncedPanelLayoutChange({
    panelState,
    setState,
  });
  const resolvedPanelContent = useMemo(
    () => contextExplorerPanelContent ?? <ExplorerSearchTabs />,
    [contextExplorerPanelContent]
  );
  // Platform-injected markdown preview capabilities (external links, image src
  // resolution). Detected by the `window.platform` bridge (capability presence,
  // not isElectron); WorkspaceTabHost consumes this via the nullable hook.
  const markdownPreviewCapabilities = useMarkdownPreviewCapabilitiesValue();

  return (
    <FileTreeWrapper>
      {/* The outer shell owns workspace-vs-assistant geometry; this nested provider owns
          the route-local context explorer panes inside that workspace surface. The
          editor area itself hosts the Context Explorer app and any open file tabs;
          there is no longer a south "console" panel. */}
      <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
        <MarkdownPreviewCapabilitiesProvider capabilities={markdownPreviewCapabilities}>
          <IdeLayout
            panelConstraints={CONTEXT_EXPLORER_PANEL_CONSTRAINTS}
            panelIdPrefix="context-explorer"
            rightPanelChrome={EXPLORER_RIGHT_PANEL_CHROME}
            rightPanelContent={resolvedPanelContent}
          >
            {/* The ⌘P quick-open host mounts INSIDE IdeLayout so it can reach the
                file-open seam (IdeFileEditorContext, registered by the tab host).
                This subtree is always mounted (the explorer route is only toggled
                hidden), so ⌘P works from any tab. */}
            <QuickOpenHost />
            {contextExplorerPageContent}
          </IdeLayout>
        </MarkdownPreviewCapabilitiesProvider>
      </PanelLayoutProvider>
    </FileTreeWrapper>
  );
}

const ExplorerAppSurface = memo(function ExplorerAppSurface({
  contextExplorerPanelContent,
  contextExplorerPageContent,
  databaseTabChunkingMode,
  loadEmbeddingQueue,
  loadLocalLlmBackend,
  preloadDatabaseTabOnMount,
  visible,
}: {
  readonly contextExplorerPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly databaseTabChunkingMode: 'host-proxy' | 'local';
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
  readonly preloadDatabaseTabOnMount: boolean;
  readonly visible: boolean;
}): ReactElement {
  return (
    <div className="h-full min-h-0" data-testid="explorer-section">
      <AgentWorkspaceLayout
        assistantContent={
          <AssistantChatPanel {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})} />
        }
        sidebarContent={
          <AgentSidebarPanel
            databaseContent={
              <DatabasePanel
                chunkingMode={databaseTabChunkingMode}
                loadEmbeddingQueue={loadEmbeddingQueue}
              />
            }
            preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
            promptsContent={(isActive) => (
              <Suspense
                fallback={
                  <div
                    className="grid h-full place-items-center text-muted-foreground text-xs"
                    data-testid="prompt-workbench-lazy-fallback"
                    role="status"
                  >
                    Opening Prompt Workbench…
                  </div>
                }
              >
                <ConnectedPromptManagerLazy
                  loadEmbeddingQueue={loadEmbeddingQueue}
                  suggestionsEnabled={visible && isActive}
                />
              </Suspense>
            )}
            threadsContent={<ThreadsPanel loadEmbeddingQueue={loadEmbeddingQueue} />}
          />
        }
        workspaceContent={
          <ContextExplorerSurface
            contextExplorerPageContent={contextExplorerPageContent}
            contextExplorerPanelContent={contextExplorerPanelContent}
          />
        }
      />
    </div>
  );
});

export function RootLayoutContent({
  contextExplorerPageContent,
  contextExplorerPanelContent,
  settingsPageContent,
  gitPageContent,
  notesPageContent,
  terminalPageContent,
  navigationItems,
  loadEmbeddingQueue = null,
  loadLocalLlmBackend,
  databaseTabChunkingMode = 'local',
  preloadDatabaseTabOnMount = false,
}: RootLayoutContentProps): ReactElement {
  const activeTab = usePanelLayoutStore((state) => state.activeTab);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const settingsOpen = usePanelLayoutStore((state) => state.settingsOpen);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const setSettingsOpen = usePanelLayoutStore((state) => state.setSettingsOpen);
  const setState = usePanelLayoutStore((state) => state.setState);
  const shellTab = activeTab === 'settings' ? 'explorer' : activeTab;
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<PanelTab>>(() => new Set([shellTab]));
  const appConfig = useMemo(
    () =>
      createAppConfig({
        navigationItems: navigationItems.filter((item) => item.path !== '/settings'),
      }),
    [navigationItems]
  );
  // useMemo with [] is correct: the preload bridge exists before React mounts,
  // so capability detection at first render is stable for the window's lifetime.
  const actionRegistry = useMemo(() => createAppActionRegistry(), []);

  useEffect(() => {
    setMountedTabs((currentTabs) => {
      if (currentTabs.has(shellTab)) {
        return currentTabs;
      }
      const nextTabs = new Set(currentTabs);
      nextTabs.add(shellTab);
      return nextTabs;
    });
  }, [shellTab]);

  const handleSettingsOpenChange = useCallback(
    (open: boolean) => {
      setSettingsOpen(open);
      if (!open && activeTab === 'settings') {
        setActiveTab('explorer');
      }
    },
    [activeTab, setActiveTab, setSettingsOpen]
  );

  const handleNavigationClick = useCallback(
    (path: string) => {
      if (path === '/settings') {
        openSettings();
        return;
      }
      setActiveTab(resolveActiveTabForPath(path));
    },
    [openSettings, setActiveTab]
  );
  const panelState = usePanelLayoutStore(
    (state) => ({
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      sizes: state.sizes,
    }),
    shallow
  );
  const handlePanelLayoutChange = useDebouncedPanelLayoutChange({
    panelState,
    setState,
  });

  // The shared FileSystemProvider mounts inside AppLayout (below the
  // FileExplorerProvider store it reads) — see app-layout.tsx.
  return (
    <AppLayout
      config={appConfig}
      currentPath={shellTab === 'explorer' ? '/' : `/${shellTab}`}
      onNavigationClick={handleNavigationClick}
      onOpenSettings={openSettings}
    >
      {/* These providers now intentionally stay app-wide so background chunking and embedding
          work can continue across route switches. They remain inert on non-explorer routes
          unless a feature explicitly opts into them. */}
      <ActionRegistryProvider registry={actionRegistry}>
        {/* The ⌘K command palette mounts once at the visible-UI root. Only the
            visible renderer mounts RootLayoutContent, so hidden hosts never
            instantiate it (structural gating — no role check needed here). */}
        <CommandPaletteHost />
        <ChunkingWorkerProvider autoStart={false} mode={databaseTabChunkingMode}>
          <EmbeddingRuntimeProvider>
            {/* One shared embedder cache for every semantic-search surface. The
                machinery is lazy (models load on first embed), so this
                always-mounted provider is free until the first query. It
                encloses BOTH the collection browser (sidebar DatabasePanel) and
                the workspace-search panel (ExplorerSearchTabs) below. */}
            <SearchEmbedderProvider>
              <IndexingActivityCoordinator />
              <div
                aria-hidden={shellTab !== 'explorer'}
                className={shellTab === 'explorer' ? 'h-full min-h-0' : 'hidden h-full min-h-0'}
                data-testid="explorer-route"
              >
                <PanelLayoutProvider
                  controlledState={panelState}
                  onChange={handlePanelLayoutChange}
                >
                  <ExplorerAppSurface
                    contextExplorerPageContent={contextExplorerPageContent}
                    contextExplorerPanelContent={contextExplorerPanelContent}
                    databaseTabChunkingMode={databaseTabChunkingMode}
                    loadEmbeddingQueue={loadEmbeddingQueue}
                    {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                    preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
                    visible={shellTab === 'explorer'}
                  />
                </PanelLayoutProvider>
              </div>
              <Dialog
                onOpenChange={handleSettingsOpenChange}
                open={settingsOpen || activeTab === 'settings'}
              >
                <DialogContent
                  aria-describedby={undefined}
                  className="h-[min(780px,calc(100vh-3rem))] max-h-[calc(100vh-3rem)] w-[min(1180px,calc(100vw-3rem))] max-w-none gap-0 overflow-hidden rounded-2xl border-border/70 bg-background p-0 shadow-[0_32px_96px_-24px_rgba(0,0,0,0.55)] sm:max-w-none"
                  overlayClassName="bg-background/55 backdrop-blur-md"
                >
                  <DialogTitle className="sr-only">Settings</DialogTitle>
                  {settingsPageContent}
                </DialogContent>
              </Dialog>
              {gitPageContent && mountedTabs.has('git') ? (
                <div
                  aria-hidden={shellTab !== 'git'}
                  className={shellTab === 'git' ? 'h-full' : 'hidden h-full'}
                  data-testid="git-route"
                >
                  {gitPageContent}
                </div>
              ) : null}
              {/* The terminal route stays MOUNTED once first opened (it is only
                toggled hidden) so switching tabs never kills the running shell —
                the pty is pinned to its cwd for the session's lifetime. */}
              {terminalPageContent && mountedTabs.has('terminal') ? (
                <div
                  aria-hidden={shellTab !== 'terminal'}
                  className={shellTab === 'terminal' ? 'h-full' : 'hidden h-full'}
                  data-testid="terminal-route"
                >
                  {terminalPageContent}
                </div>
              ) : null}
              {/* Stays mounted once opened so vault watchers, scan state, and
                the viewer's scroll position survive tab switches. */}
              {notesPageContent && mountedTabs.has('notes') ? (
                <div
                  aria-hidden={shellTab !== 'notes'}
                  className={shellTab === 'notes' ? 'h-full' : 'hidden h-full'}
                  data-testid="notes-route"
                >
                  {notesPageContent}
                </div>
              ) : null}
            </SearchEmbedderProvider>
          </EmbeddingRuntimeProvider>
        </ChunkingWorkerProvider>
      </ActionRegistryProvider>
    </AppLayout>
  );
}
