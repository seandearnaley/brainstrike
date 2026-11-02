import {
  hasRendererClosePreparationStarted,
  registerDurableFlush,
} from '@brainstrike/app-state/renderer-close';
import {
  type PanelTab,
  usePanelLayoutStore,
} from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type ChangesReviewContextValue,
  ChangesReviewProvider,
  ContextMapLinkContext,
  type ContextMapLinkValue,
  type RewindContextValue,
  RewindProvider,
  ToolApprovalGrantProvider,
} from '@brainstrike/assistant-ui';
import { MarkdownPreviewCapabilitiesProvider } from '@brainstrike/file-explorer-ui';
import {
  useFileSystem,
  type WorkspaceApp,
  WorkspaceBody,
  WorkspaceOpenFileBridge,
  WorkspaceTabStrip,
} from '@brainstrike/file-explorer-ui/shell';
import { FileTreeProvider } from '@brainstrike/file-explorer-ui/tree';
import {
  THREAD_CONTEXT_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { McpElicitationHost } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-host';
import {
  ActionRegistryProvider,
  PanelLayoutProvider,
  type PanelLayoutState,
  TabPanelBoundary,
} from '@brainstrike/ui';
import {
  type ReactElement,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shallow } from 'zustand/shallow';
import { AgentWorkspaceLayout } from './agent-workspace-layout';
import { createAppConfig } from './app-config';
import { AppLayout } from './app-layout';
import { AssistantChatPanel, AssistantProviderStatusProvider } from './assistant-chat-panel';
import { resolveBrowserBridge } from './browser-pane/browser-bridge';
import { useBrowserPageSync } from './browser-pane/use-browser-page-sync';
import { buildWorkspaceApps } from './build-workspace-apps';
import { useCanvasAutoOpen } from './canvas/use-canvas-auto-open';
import { useChangesNavigationStore } from './changes/changes-navigation-store';
import { useRewindStore } from './changes/rewind-store';
import { RewindConfirmDialogLazy } from './changes/ui/rewind-confirm-dialog-lazy';
import { useRewindPortFor } from './changes/use-rewind-port-for';
import { CommandPaletteHost } from './command-palette-host';
import { createAppActionRegistry } from './context-action-registry';
import { DelegatedWorkspaceTabsProvider } from './delegated-workspace-apps';
import {
  type RendererDiagnosticSurface,
  rendererLongTaskTelemetry,
} from './diagnostics/renderer-long-task-telemetry';
import { ExplorerSearchTabs } from './explorer-search-tabs';
import { useAppMenuSettings } from './hooks/use-app-menu-settings';
import { McpPromptComposerHost } from './mcp-prompts/mcp-prompt-host';
import { WorkspaceRootIdentity } from './roots/workspace-root-identity';
import type { StateHealthCapability } from './state-health/state-health-capability';
import { TabChordHost } from './tab-chords/tab-chord-host';
import { WorkspaceTabChords } from './tab-chords/workspace-tab-chords';
import { ThreadWorkspaceCoordinator } from './thread-workspace/thread-workspace-coordinator';
import { ThreadsPanel } from './threads-panel';
import type { NavigationItem } from './types';
import { useMarkdownPreviewCapabilitiesValue } from './use-markdown-preview-capabilities';
import { useToolApprovalGrantHandlers } from './use-tool-approval-grant-handlers';
import { WorkspaceConnectHost } from './workspace-connect/workspace-connect-host';

interface DebouncedPanelLayoutState {
  readonly showConsole: boolean;
  readonly showLeftPanel: boolean;
  readonly showRightPanel: boolean;
  readonly sizes: [number, number, number];
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
  return (
    <FileTreeProvider
      rootDirectoryHandle={rootDirectoryHandle}
      {...(rootId !== undefined && { rootId })}
    >
      <WorkspaceRootIdentity>{children}</WorkspaceRootIdentity>
    </FileTreeProvider>
  );
}

export interface RootLayoutContentProps {
  /**
   * Optional Artifacts gallery route: every canvas the agent host's threads
   * hold, presence-gated on a host that lists them. When absent, no
   * Artifacts nav-rail entry or route renders.
   */
  readonly artifactsPageContent?: ReactNode;
  /**
   * URL of the trusted Canvas shell (BST-1173), presence-gated like
   * `changesPageContent`: each canvas opens in a workspace tab of its own,
   * framed by this platform-specific shell. When absent, no canvas tab opens.
   */
  readonly canvasShellSrc?: string;
  /**
   * Optional Changes surface (desktop-only). Supplied by the desktop wrapper
   * when the Changes bridge is present; web never constructs it
   * (capability gating, not an isElectron check). Registered as a closable
   * singleton workspace app tab (BST-1258 unified workspace tab panel), not
   * as its own nav-rail page. When absent, no Changes tab or launcher card
   * renders at all, and the "→ Review" assistant-turn footer link stays
   * hidden (its provider binds to this same presence check).
   */
  readonly changesPageContent?: ReactNode;
  /**
   * Active flags from an authoritative app-owned feature-flag registry.
   * Omit when the app has no such registry; diagnostics surfaces that absence.
   */
  readonly diagnosticFeatureFlags?: readonly string[];
  /**
   * Optional Logs surface (BST-1791): the log viewer, with Settings keeping the
   * logging configuration. Each host supplies its own log sources; when absent,
   * no Logs tab renders.
   */
  readonly logsPageContent?: ReactNode;
  readonly navigationItems: NavigationItem[];
  readonly settingsPageContent: ReactNode;
  /** The canonical state store's health and recovery (BST-1880); desktop supplies it. */
  readonly stateHealth?: StateHealthCapability | null;
  /**
   * Optional Terminal surface (desktop-only). Supplied by the desktop wrapper
   * when its agent host provides a terminal bridge; web never constructs it
   * (capability gating, not an isElectron check). Registered as a closable
   * singleton workspace app tab (BST-1270); when absent, no Terminal tab,
   * launcher card, or "+"-menu entry renders at all.
   */
  readonly terminalPageContent?: ReactNode;
  /**
   * Optional thread context map (ADR-0021, desktop-only): what the active
   * thread's model received. Registered as a singleton workspace app tab and
   * bound to the composer popover's "Open context map" link; when absent,
   * neither renders.
   */
  readonly threadContextPageContent?: ReactNode;
  /**
   * Optional Worktree Map surface (desktop-only). Supplied by the desktop
   * wrapper when the worktrees bridge is present; web never constructs
   * it. Registered as a closable singleton workspace app tab (BST-1392); when
   * absent, no Worktrees tab, launcher card, or "+"-menu entry renders at all.
   */
  readonly worktreeMapPageContent?: ReactNode;
}

const NAV_PATH_TO_TAB: Record<string, PanelTab> = {
  '/artifacts': 'artifacts',
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
 * The wrappers append their capability-gated routes (Artifacts) AFTER
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
 * A shell route (Artifacts, Settings) that, once first opened, STAYS
 * mounted and only toggles hidden — so its watchers/scan state/scroll
 * position/in-progress edits survive later tab switches. `content` is
 * `undefined` when the app wrapper never constructed the surface at all
 * (capability absent); this renders nothing in that case, same as an
 * unopened tab.
 * Extracted out of `RootLayoutContent`'s own JSX (rather than inline
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
 * straight capability-presence gate, same shape as `terminalPageContent`/etc.
 *
 * The Changes surface lives as a closable singleton workspace app tab
 * (BST-1258 unified workspace tab panel), not its own top-level route, so
 * opening it from here is two steps: bring the shell back to the `explorer`
 * route (in case the user is on Settings/Artifacts — the workspace panel only
 * exists on that route), and hand the changeset to `openChangeset`, which
 * opens/activates the Changes app tab through
 * `useWorkspaceTabSelectionStore.openApp` (see that store action's doc
 * comment for why `openChangeset`, not `requestChangeset`, is the one
 * external callers use).
 */
/**
 * Binds the composer popover's "Open context map" link (ADR-0021) to the
 * Context workspace tab. Gated like the Review link: no page content, no link.
 */
function useContextMapLinkValue(
  threadContextPageContent: ReactNode,
  setActiveTab: (tab: PanelTab) => void
): ContextMapLinkValue | null {
  return useMemo(() => {
    if (!threadContextPageContent) {
      return null;
    }
    return {
      openContextMap: () => {
        useWorkspaceTabSelectionStore.getState().openApp(THREAD_CONTEXT_APP_ID);
        setActiveTab('explorer');
      },
    };
  }, [threadContextPageContent, setActiveTab]);
}

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
 * `useChangesReviewValue`: no `changesPageContent` means no Changes
 * bridge, so the affordance renders nothing rather than raising a modal that
 * could never load a preview.
 *
 * Raising is not applying — the scope choice, the file preview and the conflict
 * acknowledgment all live in the modal.
 */
function useRewindValue(changesPageContent: ReactNode): RewindContextValue | null {
  const openRewind = useRewindStore((state) => state.openRewind);
  const portFor = useRewindPortFor();
  return useMemo(() => {
    if (!(changesPageContent && portFor)) {
      return null;
    }
    return {
      requestRewind: ({ composerText, messageId, threadId }) =>
        openRewind({ composerText, port: portFor(threadId), target: { messageId, threadId } }),
    };
  }, [changesPageContent, openRewind, portFor]);
}

function useDebouncedPanelLayoutChange(options: {
  readonly panelState: DebouncedPanelLayoutState;
  readonly setState: (next: DebouncedPanelLayoutState) => void;
}) {
  const { panelState, setState } = options;
  const panelStateRef = useRef(panelState);
  const setStateRef = useRef(setState);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The resize the debounce still holds: the panel layout's only write-behind tail. */
  const pendingSizesRef = useRef<DebouncedPanelLayoutState | null>(null);

  useLayoutEffect(() => {
    panelStateRef.current = panelState;
    setStateRef.current = setState;
  });

  const cleanupSizeDebounce = () => {
    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
    }
  };

  /** Commits the held resize; the panel layout store writes it through to storage at once. */
  const commitPendingSizes = () => {
    if (sizeDebounceRef.current) {
      clearTimeout(sizeDebounceRef.current);
      sizeDebounceRef.current = null;
    }
    const pending = pendingSizesRef.current;
    pendingSizesRef.current = null;
    if (pending) {
      setStateRef.current(pending);
    }
  };

  useEffect(() => cleanupSizeDebounce, [cleanupSizeDebounce]);
  // Every document unload commits a held resize first (ADR-0026 R1).
  useEffect(() => {
    if (hasRendererClosePreparationStarted()) {
      return;
    }
    return registerDurableFlush(async () => {
      commitPendingSizes();
    });
  }, [commitPendingSizes]);

  // Stable callback: all mutable panel state flows through refs so resize commits
  // do not recreate the outer or inner layout trees.
  return (state: PanelLayoutState) => {
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
      pendingSizesRef.current = null;
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
    pendingSizesRef.current = {
      ...currentPanelState,
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      sizes: nextSizes,
    };
    sizeDebounceRef.current = setTimeout(commitPendingSizes, 150);
  };
}

/**
 * The Files workspace app (ADR-0021, BST-2018): the explorer and search are the
 * whole page. The file tree's `openFileInTab` reaches the outer workspace tabs
 * through the outer layout's `IdeFileEditorContext`, which this subtree sits in.
 */
function FilesAppSurface(): ReactElement {
  return <ExplorerSearchTabs />;
}

function ExplorerAppSurface({
  canvasShellSrc,
  changesPageContent,
  logsPageContent,
  terminalPageContent,
  threadContextPageContent,
  worktreeMapPageContent,
}: {
  readonly canvasShellSrc?: string | undefined;
  readonly changesPageContent?: ReactNode;
  readonly logsPageContent?: ReactNode;
  readonly terminalPageContent?: ReactNode;
  readonly threadContextPageContent?: ReactNode;
  readonly worktreeMapPageContent?: ReactNode;
}): ReactElement {
  // Platform-injected markdown preview capabilities (external links, image src
  // resolution). Detected by the `window.platform` bridge (capability presence,
  // not isElectron); file tab bodies consume this via the nullable hook. Hoisted
  // above the whole layout because file bodies now render at the workspace level.
  const markdownPreviewCapabilities = useMarkdownPreviewCapabilitiesValue();
  useCanvasAutoOpen(canvasShellSrc !== undefined);
  // The preload bridge exists before React mounts, so the desktop browser's
  // presence at first render holds for the window's lifetime (BST-1271).
  const browser = resolveBrowserBridge();
  useBrowserPageSync(browser);

  // The workspace app registry (BST-1258; Terminal joined as a workspace app
  // in BST-1270, replacing its nav route). Construction is the pure
  // buildWorkspaceApps helper — capability gating by omission.
  const toolApprovalGrants = useToolApprovalGrantHandlers();
  const workspaceStripRootRef = useRef<HTMLDivElement>(null);
  const workspaceApps: readonly WorkspaceApp[] = buildWorkspaceApps({
    ...(changesPageContent ? { changesPageContent } : {}),
    filesContent: <FilesAppSurface />,
    ...(logsPageContent ? { logsPageContent } : {}),
    ...(terminalPageContent ? { terminalPageContent } : {}),
    ...(threadContextPageContent ? { threadContextPageContent } : {}),
    ...(worktreeMapPageContent ? { worktreeMapPageContent } : {}),
  });

  return (
    <div className="h-full min-h-0" data-testid="explorer-section">
      {/* FileTreeWrapper + markdown capabilities wrap the WHOLE layout (not just
          the Files app) because the tab strip lives in the panel HEADER and file
          bodies render at the workspace level — both need the file-explorer
          context from a common ancestor. */}
      <FileTreeWrapper>
        <MarkdownPreviewCapabilitiesProvider capabilities={markdownPreviewCapabilities}>
          {/* One read of the host's provider status for the root panel and the
              child conversations its workspace tabs render. */}
          <AssistantProviderStatusProvider>
            <DelegatedWorkspaceTabsProvider
              apps={workspaceApps}
              browser={browser}
              canvasShellSrc={canvasShellSrc}
            >
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
                  assistantContent={<AssistantChatPanel />}
                  sidebarContent={
                    // No resetKey: this panel is a singleton; "Reload tab" is the reset.
                    <TabPanelBoundary label="Threads">
                      <ThreadsPanel />
                    </TabPanelBoundary>
                  }
                  workspaceContent={
                    <>
                      {/* The open-file registration mounts INSIDE the outer IdeLayout so
                      it reaches its IdeFileEditorContext; the nested explorer layout
                      inherits the same seam. */}
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
          </AssistantProviderStatusProvider>
        </MarkdownPreviewCapabilitiesProvider>
      </FileTreeWrapper>
    </div>
  );
}

export function RootLayoutContent({
  stateHealth,
  artifactsPageContent,
  canvasShellSrc,
  changesPageContent,
  settingsPageContent,
  logsPageContent,
  terminalPageContent,
  threadContextPageContent,
  worktreeMapPageContent,
  navigationItems,
  diagnosticFeatureFlags,
}: RootLayoutContentProps): ReactElement {
  const shellTab = usePanelLayoutStore((state) => state.activeTab);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const setState = usePanelLayoutStore((state) => state.setState);
  useAppMenuSettings();
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<PanelTab>>(() => new Set([shellTab]));
  const appConfig = createAppConfig({ navigationItems: orderNavigationItems(navigationItems) });
  // Resolved once: the preload bridge exists before React mounts, so capability
  // detection at first render is stable for the window's lifetime.
  const actionRegistry = createAppActionRegistry();
  // Capability gate mirrors terminalPageContent:
  // the desktop wrapper only passes changesPageContent when the Changes bridge
  // exists, so its presence IS the capability check here — the "→ Review"
  // footer link (packages/ui, gated on this same context) renders null without it.
  const changesReviewValue = useChangesReviewValue(changesPageContent, setActiveTab);
  const contextMapLinkValue = useContextMapLinkValue(threadContextPageContent, setActiveTab);
  const rewindValue = useRewindValue(changesPageContent);
  // Settings is a shell route like every other tab (BST-1668), so the tab
  // chrome, the telemetry route and `useDocumentTitle` all derive from the
  // one `activeTab` value and cannot drift apart.
  // Assignment (not a cast) so `PanelTab ⊆ RendererDiagnosticSurface` stays a
  // compile-time check as either union gains members.
  const diagnosticSurface: RendererDiagnosticSurface = shellTab;
  const longTaskContext = {
    enabledFeatureFlags: diagnosticFeatureFlags ?? null,
    route: diagnosticSurface,
  };
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

  const handleNavigationClick = (path: string) => setActiveTab(resolveActiveTabForPath(path));
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

  return (
    <AppLayout
      config={appConfig}
      currentPath={shellTab === 'explorer' ? '/' : `/${shellTab}`}
      onNavigationClick={handleNavigationClick}
      onOpenSettings={openSettings}
      stateHealth={stateHealth ?? null}
    >
      {/* Binds the assistant turn footer's "→ Review" link (packages/ui) to the
          Changes tab-switch + pending-changeset handoff. `null` value (no
          changesPageContent) makes the link render nothing — same capability
          gating as the Artifacts nav item. */}
      <ChangesReviewProvider value={changesReviewValue}>
        <ContextMapLinkContext value={contextMapLinkValue}>
          {/* Binds the assistant panel's "Restore to before this message"
            affordance (BST-1115). The modal it raises is mounted below, as a
            lexical SIBLING of every shell route rather than inside any
            surface, because both entry points (assistant panel, Changes
            header) must land in the same one. */}
          <RewindProvider value={rewindValue}>
            <ActionRegistryProvider registry={actionRegistry}>
              {/* The ⌘K command palette mounts once at the visible-UI root. */}
              <CommandPaletteHost />
              {/* Tab chords (BST-1842): mounted once beside the palette. */}
              <TabChordHost />
              <WorkspaceConnectHost />
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
                    canvasShellSrc={canvasShellSrc}
                    changesPageContent={changesPageContent}
                    logsPageContent={logsPageContent}
                    terminalPageContent={terminalPageContent}
                    threadContextPageContent={threadContextPageContent}
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
              {/* The Artifacts gallery: every thread's canvases. */}
              <KeepMountedRoute
                content={artifactsPageContent}
                mountedTabs={mountedTabs}
                shellTab={shellTab}
                tab="artifacts"
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
        </ContextMapLinkContext>
      </ChangesReviewProvider>
    </AppLayout>
  );
}
