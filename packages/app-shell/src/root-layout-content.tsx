import { useContextExplorerLayoutStore } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/app-state/stores/panel-layout-store';
import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import {
  type ChangesReviewContextValue,
  ChangesReviewProvider,
  type RewindContextValue,
  RewindProvider,
  ToolApprovalGrantProvider,
} from '@brainstrike/assistant-ui';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { MarkdownPreviewCapabilitiesProvider } from '@brainstrike/file-explorer-ui';
import {
  RootDataDeletionProvider,
  useFileSystem,
  type WorkspaceApp,
  WorkspaceBody,
  WorkspaceOpenFileBridge,
  WorkspaceTabStrip,
} from '@brainstrike/file-explorer-ui/shell';
import { FileTreeProvider } from '@brainstrike/file-explorer-ui/tree';
import { ChunkingWorkerProvider } from '@brainstrike/file-import/chunking-worker-context';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { QueueAdapter } from '@brainstrike/queue';
import { McpElicitationHost } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-host';
import {
  ActionRegistryProvider,
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
  useLayoutEffect,
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
import { buildWorkspaceApps } from './build-workspace-apps';
import { useChangesNavigationStore } from './changes/changes-navigation-store';
import { useRewindStore } from './changes/rewind-store';
import { RewindConfirmDialogLazy } from './changes/ui/rewind-confirm-dialog-lazy';
import { CommandPaletteHost } from './command-palette-host';
import { ConnectedPromptManagerLazy } from './connected-prompt-manager-lazy';
import { createAppActionRegistry } from './context-action-registry';
import { DatabasePanel } from './database-panel';
import { DelegatedWorkspaceTabsProvider } from './delegated-workspace-apps';
import { deleteRootData as deleteOwnedRootData } from './delete-root-data';
import {
  type RendererDiagnosticSurface,
  rendererLongTaskTelemetry,
} from './diagnostics/renderer-long-task-telemetry';
import { ExplorerSearchTabs } from './explorer-search-tabs';
import { McpPromptComposerHost } from './mcp-prompts/mcp-prompt-host';
import { QuickOpenHost } from './quick-open-host';
import { TabChordHost } from './tab-chords/tab-chord-host';
import { WorkspaceTabChords } from './tab-chords/workspace-tab-chords';
import { ThreadWorkspaceCoordinator } from './thread-workspace/thread-workspace-coordinator';
import { ThreadsPanel } from './threads-panel';
import type { NavigationItem } from './types';
import { useMarkdownPreviewCapabilitiesValue } from './use-markdown-preview-capabilities';
import { useToolApprovalGrantHandlers } from './use-tool-approval-grant-handlers';
import { WorkspaceConnectHost } from './workspace-connect/workspace-connect-host';
// Side-effect: register session-only stores with the factory-reset pipeline.
import './register-factory-reset-session-stores';

interface DebouncedPanelLayoutState {
  readonly showConsole: boolean;
  readonly showLeftPanel: boolean;
  readonly showRightPanel: boolean;
  readonly sizes: [number, number, number];
}

function FileTreeWrapper({
  children,
  nativeIndexSearch,
  deleteRootData: platformDeleteRootData,
}: {
  children: ReactNode;
  nativeIndexSearch?: IndexSearchCapability | null;
  deleteRootData?: (rootId: string) => Promise<void>;
}): ReactElement {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  // Storage v5: pass the durable RootId so the FileTreeProvider keys its index
  // and stamps IFileNode.rootFolderId with the UUID instead of the handle path.
  // Prefer the stamped handle.rootId — the path→id map collides for same-named
  // web roots (it keeps only the last), so it cannot identify the focused one.
  const rootId = rootDirectoryHandle
    ? (rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path))
    : undefined;
  const db = usePGliteDatabase();
  const deleteRootData = useCallback(
    (rootIdToDelete: string): Promise<void> =>
      deleteOwnedRootData(db, rootIdToDelete, platformDeleteRootData),
    [db, platformDeleteRootData]
  );
  return (
    <FileTreeProvider
      rootDirectoryHandle={rootDirectoryHandle}
      {...(rootId !== undefined && { rootId })}
    >
      <RootDataDeletionProvider deleteRootData={deleteRootData}>
        <WorkspaceCollectionSyncProvider nativeIndexSearch={nativeIndexSearch ?? null}>
          {children}
        </WorkspaceCollectionSyncProvider>
      </RootDataDeletionProvider>
    </FileTreeProvider>
  );
}

export interface RootLayoutContentProps {
  /**
   * Optional embedded browser pane surface (BST-1174), presence-gated on the
   * desktop `window.browser` bridge (absent on web — no stub). Its own
   * component reports native-view bounds/occlusion.
   */
  readonly browserPageContent?: ReactNode;
  /**
   * Optional Canvas surface (BST-1173), presence-gated like
   * `changesPageContent`. Each app constructs it with its platform-specific
   * shell URL; available on both targets.
   */
  readonly canvasPanelContent?: ReactNode;
  /**
   * Optional Changes surface (desktop-only). Supplied by the desktop wrapper
   * when the `window.changes` bridge is present; web never constructs it
   * (capability gating, not an isElectron check). Registered as a closable
   * singleton workspace app tab (BST-1258 unified workspace tab panel), not
   * as its own nav-rail page. When absent, no Changes tab or launcher card
   * renders at all, and the "→ Review" assistant-turn footer link stays
   * hidden (its provider binds to this same presence check).
   */
  readonly changesPageContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly contextExplorerPanelContent?: ReactNode;
  readonly databaseTabChunkingMode?: 'host-proxy' | 'local';
  readonly deleteRootData?: (rootId: string) => Promise<void>;
  /**
   * Active flags from an authoritative app-owned feature-flag registry.
   * Omit when the app has no such registry; diagnostics surfaces that absence.
   */
  readonly diagnosticFeatureFlags?: readonly string[];
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
  readonly nativeIndexSearch?: IndexSearchCapability | null;
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
   * (capability gating, not an isElectron check). Registered as a closable
   * singleton workspace app tab (BST-1270); when absent, no Terminal tab,
   * launcher card, or "+"-menu entry renders at all.
   */
  readonly terminalPageContent?: ReactNode;
  /**
   * Optional Worktree Map surface (desktop-only). Supplied by the desktop
   * wrapper when the `window.worktrees` bridge is present; web never constructs
   * it. Registered as a closable singleton workspace app tab (BST-1392); when
   * absent, no Worktrees tab, launcher card, or "+"-menu entry renders at all.
   */
  readonly worktreeMapPageContent?: ReactNode;
}

const NAV_PATH_TO_TAB: Record<string, PanelTab> = {
  '/browser': 'browser',
  '/git': 'git',
  '/notes': 'notes',
  '/settings': 'settings',
  // '/terminal' intentionally absent (BST-1270): Terminal is a workspace app
  // now. activeTab is SESSION-ONLY (panel-layout-store partializes it away)
  // and no call site can produce 'terminal' anymore; the PanelTab member is
  // kept only to avoid churning its consumers — removing it is safe follow-up.
};

function resolveActiveTabForPath(path: string): PanelTab {
  return NAV_PATH_TO_TAB[path] ?? 'explorer';
}

const SETTINGS_NAV_PATH = '/settings';

/**
 * Nav-rail order: every route the wrappers contribute, then Settings last.
 * The wrappers append their capability-gated routes (notes/git/browser) AFTER
 * the shared `navigationItems` list, which places Settings second; the shell
 * owns the rail, so it owns the rule that Settings closes the list.
 *
 * The settings route is always mounted, so a list without the `/settings`
 * item would silently strip the rail affordance while the route stayed
 * reachable through the profile menu / ⌘K. Throw instead.
 */
function orderNavigationItems(items: readonly NavigationItem[]): NavigationItem[] {
  const settings = items.filter((item) => item.path === SETTINGS_NAV_PATH);
  if (settings.length === 0) {
    throw new Error(
      `RootLayoutContent: navigationItems has no '${SETTINGS_NAV_PATH}' item — the Settings route always mounts and needs its nav-rail entry (see @brainstrike/app-shell/navigation).`
    );
  }
  const routes = items.filter((item) => item.path !== SETTINGS_NAV_PATH);
  return [...routes, ...settings];
}

/**
 * A shell route (git/notes/browser/settings) that, once first opened, STAYS
 * mounted and only toggles hidden — so its watchers/scan state/scroll
 * position/in-progress edits survive later tab switches. `content` is
 * `undefined` when the app wrapper never constructed the surface at all
 * (capability absent); this renders nothing in that case, same as an
 * unopened tab.
 * Extracted out of `RootLayoutContent`'s own JSX (rather than four inline
 * ternaries) to keep that already-large component's cognitive complexity
 * under the lint budget.
 */
function KeepMountedRoute({
  content,
  mountedTabs,
  shellTab,
  tab,
}: {
  readonly content: ReactNode | undefined;
  readonly mountedTabs: ReadonlySet<PanelTab>;
  readonly shellTab: PanelTab;
  readonly tab: PanelTab;
}): ReactElement | null {
  if (!(content && mountedTabs.has(tab))) {
    return null;
  }
  return (
    <div
      aria-hidden={shellTab !== tab}
      className={shellTab === tab ? 'h-full' : 'hidden h-full'}
      data-testid={`${tab}-route`}
    >
      {content}
    </div>
  );
}

/**
 * The "→ Review" footer link's binding, or `null` when there is no Changes
 * surface to navigate to. A dedicated hook (rather than inlined in
 * `RootLayoutContent`) purely to keep that already-large component's
 * cognitive complexity under the lint budget — the logic itself is a
 * straight capability-presence gate, same shape as `gitPageContent`/etc.
 *
 * The Changes surface lives as a closable singleton workspace app tab
 * (BST-1258 unified workspace tab panel), not its own top-level route, so
 * opening it from here is two steps: bring the shell back to the `explorer`
 * route (in case the user is on Settings/Git/etc — the workspace panel only
 * exists on that route), and hand the changeset to `openChangeset`, which
 * opens/activates the Changes app tab through
 * `useWorkspaceTabSelectionStore.openApp` (see that store action's doc
 * comment for why `openChangeset`, not `requestChangeset`, is the one
 * external callers use).
 */
function useChangesReviewValue(
  changesPageContent: ReactNode,
  setActiveTab: (tab: PanelTab) => void
): ChangesReviewContextValue | null {
  const openChangeset = useChangesNavigationStore((state) => state.openChangeset);
  return useMemo(() => {
    if (!changesPageContent) {
      return null;
    }
    return {
      openChangesForRun: (runId: string, threadId: string) => {
        openChangeset({ kind: 'agent-run', runId, threadId });
        setActiveTab('explorer');
      },
    };
  }, [changesPageContent, openChangeset, setActiveTab]);
}

/**
 * Binds the assistant panel's "Restore to before this message" affordance
 * (BST-1115) to the Changes package's confirm modal. Same capability gate as
 * `useChangesReviewValue`: no `changesPageContent` means no `window.changes`
 * bridge, so the affordance renders nothing rather than raising a modal that
 * could never load a preview.
 *
 * Raising is not applying — the scope choice, the file preview and the conflict
 * acknowledgment all live in the modal.
 */
function useRewindValue(changesPageContent: ReactNode): RewindContextValue | null {
  const openRewind = useRewindStore((state) => state.openRewind);
  return useMemo(() => {
    if (!changesPageContent) {
      return null;
    }
    return {
      requestRewind: ({ composerText, messageId, threadId }) =>
        openRewind({ composerText, target: { messageId, threadId } }),
    };
  }, [changesPageContent, openRewind]);
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
  loadEmbeddingQueue,
}: {
  readonly contextExplorerPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
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
    () =>
      contextExplorerPanelContent ?? <ExplorerSearchTabs loadEmbeddingQueue={loadEmbeddingQueue} />,
    [contextExplorerPanelContent, loadEmbeddingQueue]
  );

  return (
    // The outer shell owns workspace-vs-assistant geometry; this nested provider owns
    // the route-local context explorer panes inside the Files workspace app (BST-1258).
    // File tabs no longer render here — they are siblings of this app in the outer
    // workspace tab panel, so the nested layout INHERITS the outer file-open seam
    // (a fresh IdeFileEditorContext here would strand the tree's openFileInTab calls).
    <PanelLayoutProvider controlledState={panelState} onChange={handlePanelLayoutChange}>
      <IdeLayout
        inheritFileEditorContext
        panelConstraints={CONTEXT_EXPLORER_PANEL_CONSTRAINTS}
        panelIdPrefix="context-explorer"
        rightPanelChrome={EXPLORER_RIGHT_PANEL_CHROME}
        rightPanelContent={resolvedPanelContent}
      >
        {contextExplorerPageContent}
      </IdeLayout>
    </PanelLayoutProvider>
  );
}

const ExplorerAppSurface = memo(function ExplorerAppSurface({
  canvasPanelContent,
  changesPageContent,
  contextExplorerPanelContent,
  contextExplorerPageContent,
  loadEmbeddingQueue,
  loadLocalLlmBackend,
  preloadDatabaseTabOnMount,
  terminalPageContent,
  worktreeMapPageContent,
  visible,
  nativeIndexSearch,
  deleteRootData,
}: {
  readonly canvasPanelContent?: ReactNode;
  readonly changesPageContent?: ReactNode;
  readonly contextExplorerPanelContent?: ReactNode;
  readonly contextExplorerPageContent: ReactNode;
  readonly loadEmbeddingQueue: (() => Promise<QueueAdapter>) | null;
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
  readonly preloadDatabaseTabOnMount: boolean;
  readonly terminalPageContent?: ReactNode;
  readonly worktreeMapPageContent?: ReactNode;
  readonly visible: boolean;
  readonly nativeIndexSearch?: IndexSearchCapability | null;
  readonly deleteRootData?: (rootId: string) => Promise<void>;
}): ReactElement {
  // Platform-injected markdown preview capabilities (external links, image src
  // resolution). Detected by the `window.platform` bridge (capability presence,
  // not isElectron); file tab bodies consume this via the nullable hook. Hoisted
  // above the whole layout because file bodies now render at the workspace level.
  const markdownPreviewCapabilities = useMarkdownPreviewCapabilitiesValue();

  // The workspace app registry (BST-1258; Terminal joined as a workspace app
  // in BST-1270, replacing its nav route). Construction is the pure
  // buildWorkspaceApps helper — capability gating by omission.
  const toolApprovalGrants = useToolApprovalGrantHandlers();
  const workspaceStripRootRef = useRef<HTMLDivElement>(null);
  const workspaceApps = useMemo<readonly WorkspaceApp[]>(
    () =>
      buildWorkspaceApps({
        ...(canvasPanelContent ? { canvasPanelContent } : {}),
        ...(changesPageContent ? { changesPageContent } : {}),
        filesContent: (
          <ContextExplorerSurface
            contextExplorerPageContent={contextExplorerPageContent}
            contextExplorerPanelContent={contextExplorerPanelContent}
            loadEmbeddingQueue={loadEmbeddingQueue}
          />
        ),
        ...(terminalPageContent ? { terminalPageContent } : {}),
        ...(worktreeMapPageContent ? { worktreeMapPageContent } : {}),
      }),
    [
      contextExplorerPageContent,
      contextExplorerPanelContent,
      loadEmbeddingQueue,
      changesPageContent,
      canvasPanelContent,
      terminalPageContent,
      worktreeMapPageContent,
    ]
  );

  return (
    <div className="h-full min-h-0" data-testid="explorer-section">
      {/* FileTreeWrapper + markdown capabilities wrap the WHOLE layout (not just
          the Files app) because the tab strip lives in the panel HEADER and file
          bodies render at the workspace level — both need the file-explorer
          context from a common ancestor. */}
      <FileTreeWrapper
        nativeIndexSearch={nativeIndexSearch ?? null}
        {...(deleteRootData ? { deleteRootData } : {})}
      >
        <MarkdownPreviewCapabilitiesProvider capabilities={markdownPreviewCapabilities}>
          <DelegatedWorkspaceTabsProvider apps={workspaceApps}>
            {/* Thread⇄workspace binding (BST-1268): snapshots the live stores
                per thread and hydrates on switch. Inside FileTreeWrapper so it
                reaches the file-explorer store; renders nothing. */}
            <ThreadWorkspaceCoordinator />
            {/* Registers the workspace strip with the tab chord router (BST-1842). */}
            <WorkspaceTabChords focusRootRef={workspaceStripRootRef} />
            {/* Grants are offered wherever an approval card can render: the root
                chat panel AND the child conversation views under the workspace
                (a child card without "Allow reads this session" forces a click
                per read; BST-1723, 2026-09-14). */}
            <ToolApprovalGrantProvider handlers={toolApprovalGrants}>
              <AgentWorkspaceLayout
                assistantContent={
                  <AssistantChatPanel {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})} />
                }
                sidebarContent={
                  <AgentSidebarPanel
                    databaseContent={<DatabasePanel loadEmbeddingQueue={loadEmbeddingQueue} />}
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
                  <>
                    {/* ⌘P quick-open + the open-file registration both mount INSIDE
                      the outer IdeLayout so they reach its IdeFileEditorContext;
                      the nested explorer layout inherits the same seam. */}
                    <QuickOpenHost />
                    <WorkspaceOpenFileBridge />
                    <WorkspaceBody />
                  </>
                }
                workspaceHeaderContent={
                  // Layout-neutral (`contents`): the root chords restore focus into.
                  <div className="contents" ref={workspaceStripRootRef}>
                    <WorkspaceTabStrip />
                  </div>
                }
              />
            </ToolApprovalGrantProvider>
          </DelegatedWorkspaceTabsProvider>
        </MarkdownPreviewCapabilitiesProvider>
      </FileTreeWrapper>
    </div>
  );
});

export function RootLayoutContent({
  nativeIndexSearch,
  deleteRootData,
  browserPageContent,
  canvasPanelContent,
  changesPageContent,
  contextExplorerPageContent,
  contextExplorerPanelContent,
  settingsPageContent,
  gitPageContent,
  notesPageContent,
  terminalPageContent,
  worktreeMapPageContent,
  navigationItems,
  loadEmbeddingQueue = null,
  loadLocalLlmBackend,
  diagnosticFeatureFlags,
  databaseTabChunkingMode = 'local',
  preloadDatabaseTabOnMount = false,
}: RootLayoutContentProps): ReactElement {
  const shellTab = usePanelLayoutStore((state) => state.activeTab);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const setState = usePanelLayoutStore((state) => state.setState);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<PanelTab>>(() => new Set([shellTab]));
  const appConfig = useMemo(
    () => createAppConfig({ navigationItems: orderNavigationItems(navigationItems) }),
    [navigationItems]
  );
  // useMemo with [] is correct: the preload bridge exists before React mounts,
  // so capability detection at first render is stable for the window's lifetime.
  const actionRegistry = useMemo(() => createAppActionRegistry(), []);
  // Capability gate mirrors gitPageContent/terminalPageContent/notesPageContent:
  // the desktop wrapper only passes changesPageContent when the `window.changes`
  // bridge exists, so its presence IS the capability check here — the "→ Review"
  // footer link (packages/ui, gated on this same context) renders null without it.
  const changesReviewValue = useChangesReviewValue(changesPageContent, setActiveTab);
  const rewindValue = useRewindValue(changesPageContent);
  // Settings is a shell route like every other tab (BST-1668), so the tab
  // chrome, the telemetry route and `useDocumentTitle` all derive from the
  // one `activeTab` value and cannot drift apart.
  // Assignment (not a cast) so `PanelTab ⊆ RendererDiagnosticSurface` stays a
  // compile-time check as either union gains members.
  const diagnosticSurface: RendererDiagnosticSurface = shellTab;
  const longTaskContext = useMemo(
    () => ({ enabledFeatureFlags: diagnosticFeatureFlags ?? null, route: diagnosticSurface }),
    [diagnosticFeatureFlags, diagnosticSurface]
  );
  const longTaskContextRef = useRef(longTaskContext);

  useLayoutEffect(() => {
    longTaskContextRef.current = longTaskContext;
    rendererLongTaskTelemetry.updateContext(longTaskContext);
  }, [longTaskContext]);

  useEffect(() => rendererLongTaskTelemetry.observe(() => longTaskContextRef.current), []);

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

  const handleNavigationClick = useCallback(
    (path: string) => setActiveTab(resolveActiveTabForPath(path)),
    [setActiveTab]
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
      {/* Binds the assistant turn footer's "→ Review" link (packages/ui) to the
          Changes tab-switch + pending-changeset handoff. `null` value (no
          changesPageContent) makes the link render nothing — same capability
          gating as the git/notes nav items below. */}
      <ChangesReviewProvider value={changesReviewValue}>
        {/* Binds the assistant panel's "Restore to before this message"
            affordance (BST-1115). The modal it raises is mounted below, as a
            lexical SIBLING of every shell route rather than inside any
            surface, because both entry points (assistant panel, Changes
            header) must land in the same one. */}
        <RewindProvider value={rewindValue}>
          <ActionRegistryProvider registry={actionRegistry}>
            {/* The ⌘K command palette mounts once at the visible-UI root. Only the
            visible renderer mounts RootLayoutContent, so hidden hosts never
            instantiate it (structural gating — no role check needed here). */}
            <CommandPaletteHost />
            {/* Tab chords (BST-1842): the same structural gating as the palette. */}
            <TabChordHost />
            <WorkspaceConnectHost />
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
                        canvasPanelContent={canvasPanelContent}
                        changesPageContent={changesPageContent}
                        contextExplorerPageContent={contextExplorerPageContent}
                        contextExplorerPanelContent={contextExplorerPanelContent}
                        loadEmbeddingQueue={loadEmbeddingQueue}
                        nativeIndexSearch={nativeIndexSearch ?? null}
                        {...(deleteRootData ? { deleteRootData } : {})}
                        {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                        preloadDatabaseTabOnMount={preloadDatabaseTabOnMount}
                        terminalPageContent={terminalPageContent}
                        visible={shellTab === 'explorer'}
                        worktreeMapPageContent={worktreeMapPageContent}
                      />
                    </PanelLayoutProvider>
                  </div>
                  {/* MCP elicitation consent is app-wide (BST-1584): desktop main
                    pushes server input requests here regardless of route, and the
                    host renders nothing when the preload bridge is absent. */}
                  <McpElicitationHost />
                  {/* Composer MCP prompt selection is app-wide (BST-1592): the
                    "/" menu's execute hands the selection here from wherever the
                    composer is mounted, and the host renders nothing when the
                    preload bridge is absent. */}
                  <McpPromptComposerHost />
                  {/* Each keeps its content mounted-but-hidden once first opened — see
                    KeepMountedRoute's own doc comment for why. */}
                  <KeepMountedRoute
                    content={gitPageContent}
                    mountedTabs={mountedTabs}
                    shellTab={shellTab}
                    tab="git"
                  />
                  <KeepMountedRoute
                    content={notesPageContent}
                    mountedTabs={mountedTabs}
                    shellTab={shellTab}
                    tab="notes"
                  />
                  {/* Embedded browser pane (BST-1174). The native
                    WebContentsView follows this route's show/hide via the
                    surface's own occlusion reporting — see BrowserPaneContent. */}
                  <KeepMountedRoute
                    content={browserPageContent}
                    mountedTabs={mountedTabs}
                    shellTab={shellTab}
                    tab="browser"
                  />
                  {/* Settings is a full shell tab (BST-1668): same keep-mounted
                    contract as the routes above, so in-progress edits survive
                    a trip to another tab. */}
                  <KeepMountedRoute
                    content={settingsPageContent}
                    mountedTabs={mountedTabs}
                    shellTab={shellTab}
                    tab="settings"
                  />
                </SearchEmbedderProvider>
              </EmbeddingRuntimeProvider>
            </ChunkingWorkerProvider>
            {/* Conversation Rewind confirm modal. Mounted only when the
                changes capability is present (`rewindValue`), so web never
                loads its chunk, and lazily so the Changes tree/diff panes stay
                out of the shell's entry chunk. Renders nothing visible until
                an entry point writes a request to `useRewindStore`. */}
            {rewindValue ? (
              <Suspense fallback={null}>
                <RewindConfirmDialogLazy />
              </Suspense>
            ) : null}
          </ActionRegistryProvider>
        </RewindProvider>
      </ChangesReviewProvider>
    </AppLayout>
  );
}
