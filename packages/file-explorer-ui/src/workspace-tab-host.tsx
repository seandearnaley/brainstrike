import {
  INACCESSIBLE_CONTENT_PREFIX,
  type TabFileStatus,
  useTabFileRestoration,
} from '@brainstrike/file-explorer-hooks';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useIdeFileEditor,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import {
  AlertCircle,
  File,
  LayoutGrid,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FileExplorerMiddlePanelBase } from './file-explorer-middle-panel-base';
import { type FileTab, useTabManager } from './hooks/use-tab-manager';
import { useEditorViewStateStore } from './stores/editor-view-state-store';
import {
  useWorkspaceTabSelectionStore,
  type WorkspaceTabSelection,
} from './stores/workspace-tab-selection-store';
import { useFileExplorer } from './use-file-explorer-context';
import { CONTEXT_EXPLORER_APP_ID, type WorkspaceApp } from './workspace-app';

const logger = createLogger('WorkspaceTabHost');

const CONTEXT_EXPLORER_APP: WorkspaceApp = {
  id: CONTEXT_EXPLORER_APP_ID,
  label: 'Context Explorer',
  icon: LayoutGrid,
  render: () => <FileExplorerMiddlePanelBase />,
};

export interface WorkspaceTabHostProps {
  /** Optional className applied to the outer container. */
  readonly className?: string;
  /**
   * Additional pinned apps appended after Context Explorer. The registry is intentionally
   * a typed array (not a global) so consumers compose statically and tests stay deterministic.
   */
  readonly extraApps?: readonly WorkspaceApp[];
}

export const WorkspaceTabHost = memo<WorkspaceTabHostProps>(function WorkspaceTabHost({
  className,
  extraApps,
}) {
  const apps = useMemo<readonly WorkspaceApp[]>(() => {
    const list = [CONTEXT_EXPLORER_APP, ...(extraApps ?? [])];
    // Dev-mode assertion: WorkspaceApp.id is used as a tab dom id and as the persistence
    // key for the active app, so collisions cause silent UI bugs (clicking one tab
    // selects another) rather than visible errors. Folded into the apps useMemo so the
    // check fires once per registry change rather than once per render.
    if (process.env['NODE_ENV'] !== 'production') {
      const seen = new Set<string>();
      for (const app of list) {
        if (seen.has(app.id)) {
          logger.error('Duplicate WorkspaceApp id detected — apps must have unique ids', {
            duplicateId: app.id,
          });
        }
        seen.add(app.id);
      }
    }
    return list;
  }, [extraApps]);

  const { tabs, openTab, closeTab, setActiveTab, clearTabs } = useTabManager();
  const { fileContents, loadingFiles, loadFileContent, fileTree, canLoadWithoutTree } =
    useFileExplorer();

  const selection = useWorkspaceTabSelectionStore((s) => s.selection);
  const selectApp = useWorkspaceTabSelectionStore((s) => s.selectApp);
  const selectFile = useWorkspaceTabSelectionStore((s) => s.selectFile);
  const selectionIntentRef = useRef(0);

  // Restoration plumbing: surfaces persisted-tab status (restored / needs-permission / not-found).
  const { tabStatuses, requestTabPermission, getStatusMessage, isRestoring } =
    useTabFileRestoration(tabs, (tabId: string) => {
      // Restoration can close stale/missing tabs after any render. Read the current
      // selection at callback time so a stale closure does not route the workspace away
      // from the user's active tab.
      const currentSelection = useWorkspaceTabSelectionStore.getState().selection;
      const closingActive = currentSelection.kind === 'file' && currentSelection.tabId === tabId;
      const successorId = closeTab(tabId);
      if (!closingActive) {
        return;
      }
      if (successorId === null) {
        selectionIntentRef.current += 1;
        selectApp(CONTEXT_EXPLORER_APP_ID);
      } else {
        selectFile(successorId);
      }
    });

  // Track in-flight permission requests to ignore double-clicks.
  const permissionRequestsInProgressRef = useRef<Set<string>>(new Set());
  // Guard async post-await work against firing on an unmounted component (the
  // permission prompt can resolve seconds after the user navigates away).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // tabsRef + tabStatusesRef let the click handlers below look up the latest tab
  // without re-creating themselves on every tab open/close or restoration tick.
  // Stable handler identity is what makes the FileTabButton memo wrap actually bail
  // on shallow-equal props (tabStatuses changes frequently during restoration; binding
  // it as a useCallback dep would re-register every hotkey on every status update).
  const tabsRef = useRef(tabs);
  const tabStatusesRef = useRef(tabStatuses);
  useEffect(() => {
    tabsRef.current = tabs;
    tabStatusesRef.current = tabStatuses;
  }, [tabs, tabStatuses]);

  const ensurePermissionForTab = useCallback(
    async (compositeKey: string): Promise<void> => {
      // Permission requests must happen synchronously from the user gesture; the
      // in-flight Set dedupes double-clicks so we don't fire two prompts.
      if (permissionRequestsInProgressRef.current.has(compositeKey)) {
        return;
      }
      permissionRequestsInProgressRef.current.add(compositeKey);
      try {
        const granted = await requestTabPermission(compositeKey);
        if (isMountedRef.current && granted) {
          void loadFileContent(compositeKey);
        }
      } catch (err) {
        logger.error('Failed to request file permission', {
          compositeKey,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        permissionRequestsInProgressRef.current.delete(compositeKey);
      }
    },
    [requestTabPermission, loadFileContent]
  );

  const handleSelectFileTab = useCallback(
    async (tabId: string) => {
      const intent = selectionIntentRef.current + 1;
      selectionIntentRef.current = intent;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }
      try {
        const status = tabStatusesRef.current.get(tab.compositeKey);
        if (status?.status === 'needs-permission') {
          await ensurePermissionForTab(tab.compositeKey);
        }
        if (!isMountedRef.current) {
          return;
        }
        if (selectionIntentRef.current !== intent) {
          return;
        }
        setActiveTab(tabId);
        selectFile(tabId);
      } catch (err) {
        // Belt-and-suspenders: ensurePermissionForTab already swallows its own errors,
        // but this catch ensures a rogue throw (e.g. from a future codepath) never
        // surfaces as an unhandled rejection through the caller's `void` invocation.
        logger.error('Tab selection failed', {
          tabId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [ensurePermissionForTab, setActiveTab, selectFile]
  );

  const handleSelectApp = useCallback(
    (appId: string) => {
      selectionIntentRef.current += 1;
      selectApp(appId);
    },
    [selectApp]
  );

  const handleCloseFileTab = useCallback(
    (tabId: string) => {
      // closeTab returns the successor activeTabId (or null if no tabs remain), so we
      // mirror that into the workspace selection without any implicit dependency on
      // Zustand's synchronous-set contract. We read selection from the store directly
      // (instead of closing over `selection`) so this callback's identity stays stable
      // across selection changes — keeping a future React.memo wrap of FileTabButton
      // effective.
      const currentSelection = useWorkspaceTabSelectionStore.getState().selection;
      const closingActive = currentSelection.kind === 'file' && currentSelection.tabId === tabId;
      const successorId = closeTab(tabId);
      if (!closingActive) {
        return;
      }
      if (successorId === null) {
        handleSelectApp(CONTEXT_EXPLORER_APP_ID);
      } else {
        selectFile(successorId);
      }
    },
    [closeTab, handleSelectApp, selectFile]
  );

  // If the workspace was pointing at a file tab that no longer exists (silent
  // eviction at MAX_TABS, external close, store reset, etc.), route back to
  // Context Explorer so the visible state matches the persisted selection.
  // WorkspaceBody handles the "tab not found" case by rendering NoFileTabSelected,
  // but leaving the selection store pointing at a dead id makes downstream
  // operations (cycle, close, hotkey targets) act on stale references.
  useEffect(() => {
    if (selection.kind !== 'file') {
      return;
    }
    if (tabs.some((t) => t.id === selection.tabId)) {
      return;
    }
    selectApp(CONTEXT_EXPLORER_APP_ID);
  }, [selection, tabs, selectApp]);

  // Auto-load active file content when tabs/file tree become ready.
  // biome-ignore lint/plugin: reactive content load — necessary side effect on activation
  useEffect(() => {
    if (selection.kind !== 'file') {
      return;
    }
    const tab = tabs.find((t) => t.id === selection.tabId);
    if (!tab) {
      return;
    }
    if (!canLoadWithoutTree && fileTree.length === 0) {
      return;
    }
    if (fileContents[tab.compositeKey] !== undefined) {
      return;
    }
    if (loadingFiles.has(tab.compositeKey)) {
      return;
    }
    const status = tabStatuses.get(tab.compositeKey);
    // Skip auto-load if the tab needs an explicit user gesture for permission.
    if (status && status.status !== 'restored') {
      return;
    }
    void loadFileContent(tab.compositeKey);
  }, [
    selection,
    tabs,
    fileContents,
    loadingFiles,
    tabStatuses,
    canLoadWithoutTree,
    fileTree,
    loadFileContent,
  ]);

  // Register openFileInTab so the FileExplorer side panel can drive opens.
  // Sync the latest snapshots into refs so the open-file callback can read them without
  // listing them as deps (which would re-register on every load tick). useEffect (not
  // useLayoutEffect) is correct here: the refs are only consulted asynchronously from
  // the user-click handler — there's no layout-phase reader that needs the new value
  // before paint.
  const fileContentsRef = useRef(fileContents);
  const loadingFilesRef = useRef(loadingFiles);
  useEffect(() => {
    fileContentsRef.current = fileContents;
    loadingFilesRef.current = loadingFiles;
  }, [fileContents, loadingFiles]);

  const { registerOpenFileInTab } = useIdeFileEditor();
  const handleOpenFileInTab = useCallback(
    (compositeKey: string) => {
      const { path } = decodeFileSelection(compositeKey);
      // tabId is the compositeKey itself — stable across reloads (it already encodes the
      // folder identity), unlike the legacy `${rootFolderId}:${compositeKey}` form.
      const tabId = compositeKey;
      openTab(path, tabId, compositeKey);
      selectFile(tabId);
      if (
        fileContentsRef.current[compositeKey] === undefined &&
        !loadingFilesRef.current.has(compositeKey)
      ) {
        void loadFileContent(compositeKey);
      }
    },
    [openTab, selectFile, loadFileContent]
  );
  useEffect(() => {
    registerOpenFileInTab(handleOpenFileInTab);
  }, [registerOpenFileInTab, handleOpenFileInTab]);

  // Hotkeys: Electron gets VS Code-style ctrl/cmd+w for closing the active editor tab.
  // Web intentionally leaves the browser's native close-tab shortcut untouched.
  // Deps array (4th arg) is required by react-hotkeys-hook v5 to avoid stale closures —
  // without it the callback would capture the first render's selection. The platform
  // check runs lazily inside the handler so the answer reflects the actual state at
  // keystroke time (preload may set window.electronAPI after this module loads).
  useHotkeys(
    'ctrl+w, cmd+w',
    (e) => {
      // Web: native Ctrl/Cmd+W closes the browser tab; do not intercept.
      if (!isDesktopRenderer()) {
        return;
      }
      if (selection.kind === 'file') {
        e.preventDefault();
        handleCloseFileTab(selection.tabId);
      }
    },
    {}, // no options; the deps array is the 4th arg (v5 signature is keys, cb, options?, deps?)
    [selection, handleCloseFileTab]
  );
  const cycleFileTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (tabs.length < 2 || selection.kind !== 'file') {
        return;
      }
      const currentIndex = tabs.findIndex((t) => t.id === selection.tabId);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        direction === 'next'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      if (next) {
        void handleSelectFileTab(next.id);
      }
    },
    [tabs, selection, handleSelectFileTab]
  );
  useHotkeys(
    'ctrl+pageup, cmd+pageup',
    (e) => {
      e.preventDefault();
      cycleFileTab('prev');
    },
    {},
    [cycleFileTab]
  );
  useHotkeys(
    'ctrl+pagedown, cmd+pagedown',
    (e) => {
      e.preventDefault();
      cycleFileTab('next');
    },
    {},
    [cycleFileTab]
  );

  // Explicit Close-All handler: route the workspace selection back to Context Explorer
  // at the call site instead of relying on the dead-selection effect to detect the
  // orphaned tabId on the next render. The effect still serves as a safety net for
  // silent-eviction and external-close paths, but making the bulk-close path explicit
  // keeps the behavior obvious and robust against future changes that might suppress
  // the effect.
  const handleCloseAllFileTabs = useCallback(() => {
    clearTabs();
    handleSelectApp(CONTEXT_EXPLORER_APP_ID);
  }, [clearTabs, handleSelectApp]);

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <WorkspaceTabStrip
        apps={apps}
        getTabStatusMessage={getStatusMessage}
        loadingFiles={loadingFiles}
        onCloseAllFileTabs={handleCloseAllFileTabs}
        onCloseFileTab={handleCloseFileTab}
        onSelectApp={handleSelectApp}
        onSelectFileTab={handleSelectFileTab}
        selection={selection}
        tabStatuses={tabStatuses}
        tabs={tabs}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceBody
          apps={apps}
          fileContents={fileContents}
          isRestoring={isRestoring}
          loadingFiles={loadingFiles}
          selection={selection}
          tabStatuses={tabStatuses}
          tabs={tabs}
        />
      </div>
    </div>
  );
});

WorkspaceTabHost.displayName = 'WorkspaceTabHost';

interface WorkspaceTabStripProps {
  readonly apps: readonly WorkspaceApp[];
  readonly getTabStatusMessage: (compositeKey: string) => string | null;
  readonly loadingFiles: Set<string>;
  /** Clear all file tabs at once. Surfaced via the overflow menu next to the tab strip. */
  readonly onCloseAllFileTabs: () => void;
  readonly onCloseFileTab: (tabId: string) => void;
  readonly onSelectApp: (appId: string) => void;
  readonly onSelectFileTab: (tabId: string) => void | Promise<void>;
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly tabs: FileTab[];
}

function WorkspaceTabStrip({
  apps,
  selection,
  onSelectApp,
  tabs,
  loadingFiles,
  tabStatuses,
  onSelectFileTab,
  onCloseFileTab,
  onCloseAllFileTabs,
  getTabStatusMessage,
}: WorkspaceTabStripProps) {
  return (
    <div
      className="flex flex-shrink-0 items-stretch border-border border-b bg-muted/30"
      role="tablist"
    >
      <div className="flex flex-shrink-0 items-stretch border-border border-r">
        {apps.map((app) => {
          const isActive = selection.kind === 'app' && selection.appId === app.id;
          return (
            <AppTabButton
              app={app}
              isActive={isActive}
              key={app.id}
              onSelect={() => onSelectApp(app.id)}
            />
          );
        })}
      </div>
      <div className="scrollbar-thin flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = selection.kind === 'file' && selection.tabId === tab.id;
          const status = tabStatuses.get(tab.compositeKey);
          const isLoading = loadingFiles.has(tab.compositeKey);
          const statusMessage = getTabStatusMessage(tab.compositeKey);
          // FileTabButton receives the parent handlers verbatim and dispatches them with
          // its own tab.id internally — no per-render arrow-closure recreation, so the
          // memo wrap on FileTabButton bails on shallow-equal props.
          return (
            <FileTabButton
              isActive={isActive}
              isLoading={isLoading}
              key={tab.id}
              onClose={onCloseFileTab}
              onSelect={onSelectFileTab}
              status={status}
              statusMessage={statusMessage}
              tab={tab}
            />
          );
        })}
      </div>
      <TabStripOverflowMenu hasFileTabs={tabs.length > 0} onCloseAll={onCloseAllFileTabs} />
    </div>
  );
}

interface TabStripOverflowMenuProps {
  readonly hasFileTabs: boolean;
  readonly onCloseAll: () => void;
}

/**
 * "More actions" affordance at the right edge of the tab strip. Mirrors the menu the
 * old TabbedFileEditor surfaced — currently just hosts "Close All Tabs", but the
 * structure is here so future bulk actions (e.g. "Close Others", "Pin Tab") can slot
 * in without rewiring the strip.
 */
function TabStripOverflowMenu({ hasFileTabs, onCloseAll }: TabStripOverflowMenuProps) {
  return (
    <div className="flex flex-shrink-0 items-center border-border border-l px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More tab actions"
            className="h-7 w-7 rounded-sm"
            size="icon"
            title="More tab actions"
            variant="ghost"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" sideOffset={6}>
          <DropdownMenuItem disabled={!hasFileTabs} onSelect={onCloseAll}>
            Close All Tabs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface AppTabButtonProps {
  readonly app: WorkspaceApp;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}

function AppTabButton({ app, isActive, onSelect }: AppTabButtonProps) {
  const Icon = app.icon;
  return (
    <button
      aria-controls={`workspace-app-panel-${app.id}`}
      aria-selected={isActive}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-primary border-b-2 bg-background text-foreground'
          : 'border-transparent border-b-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
      data-testid={`workspace-app-tab-${app.id}`}
      id={`workspace-app-tab-${app.id}`}
      onClick={onSelect}
      role="tab"
      type="button"
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium">{app.label}</span>
    </button>
  );
}

interface FileTabButtonProps {
  readonly isActive: boolean;
  readonly isLoading: boolean;
  /**
   * Handlers receive the tab id as their argument. Wiring the dispatch *inside* the
   * child (not via an inline arrow in the parent's `.map`) keeps the props stable
   * across parent re-renders so a future `React.memo` wrap on FileTabButton stays
   * effective.
   */
  readonly onClose: (tabId: string) => void;
  readonly onSelect: (tabId: string) => void | Promise<void>;
  readonly status: TabFileStatus | undefined;
  readonly statusMessage: string | null;
  readonly tab: FileTab;
}

/**
 * Memoized so an unrelated parent re-render (e.g. fileContents tick during a background
 * file load) doesn't reconcile every visible file tab. The handler props are
 * `(tabId) => …` shapes the parent passes verbatim — stable refs, so memo bails
 * cleanly when isActive/isLoading/status/statusMessage/tab are unchanged.
 */
const FileTabButton = memo<FileTabButtonProps>(function FileTabButton({
  tab,
  isActive,
  isLoading,
  status,
  statusMessage,
  onSelect,
  onClose,
}) {
  const fileName = getFileName(tab.path);
  const tabButtonId = `workspace-file-tab-${tab.id}`;
  const panelId = `workspace-file-panel-${tab.id}`;
  const handleSelect = useCallback(() => {
    void onSelect(tab.id);
  }, [onSelect, tab.id]);
  const handleClose = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id]
  );
  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center border-transparent border-r border-b-2',
        isActive ? 'border-b-primary bg-background' : 'bg-muted/30 hover:bg-muted'
      )}
    >
      <button
        aria-controls={panelId}
        aria-selected={isActive}
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          status?.status === 'needs-permission' && 'text-amber-600 dark:text-amber-400',
          status?.status === 'not-found' && 'text-destructive'
        )}
        data-testid={tabButtonId}
        id={tabButtonId}
        onClick={handleSelect}
        role="tab"
        title={statusMessage ?? fileName}
        type="button"
      >
        <FileTabIcon isLoading={isLoading} status={status} />
        <span className="max-w-[20ch] truncate">{fileName}</span>
      </button>
      <Button
        aria-label={`Close ${fileName}`}
        className="mr-1 h-6 w-6 flex-shrink-0 rounded-sm"
        onClick={handleClose}
        size="icon"
        title={`Close ${fileName}`}
        variant="ghost"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
});

interface FileTabIconProps {
  readonly isLoading: boolean;
  readonly status: TabFileStatus | undefined;
}

function FileTabIcon({ isLoading, status }: FileTabIconProps): ReactNode {
  if (isLoading) {
    return <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />;
  }
  if (status?.status === 'needs-permission') {
    return <LockKeyhole className="h-3 w-3 flex-shrink-0 text-amber-500" />;
  }
  if (status?.status === 'not-found') {
    return <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />;
  }
  return <File className="h-3 w-3 flex-shrink-0" />;
}

interface WorkspaceBodyProps {
  readonly apps: readonly WorkspaceApp[];
  readonly fileContents: { [key: string]: string };
  readonly isRestoring: boolean;
  readonly loadingFiles: Set<string>;
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly tabs: FileTab[];
}

/**
 * Memoized as a low-cost guard against unrelated parent state churn. Note that
 * `fileContents`, `loadingFiles`, and `tabStatuses` are fresh references on every
 * file-content-load tick, so the shallow-equal bail does NOT fire on those — the
 * memo only saves work when the parent re-renders for some other reason (selection
 * change, prop change). For per-tab content stability we'd need to project a
 * per-tab slice up here; today the inner `FileTabBody` handles its own subtree
 * efficiently enough that the extra projection isn't worth it.
 */
const WorkspaceBody = memo<WorkspaceBodyProps>(function WorkspaceBody({
  apps,
  selection,
  tabs,
  fileContents,
  loadingFiles,
  tabStatuses,
  isRestoring,
}) {
  // Resolve the active app and memoize its rendered body keyed on the app reference.
  // The body re-renders only when the active app changes — not on every fileContents /
  // tabStatuses tick — and a future extraApps consumer that returns an inline-lambda
  // tree from render() won't trigger spurious remounts of its subtree.
  const activeApp =
    selection.kind === 'app' ? apps.find((a) => a.id === selection.appId) : undefined;
  const activeAppBody = useMemo(() => activeApp?.render() ?? null, [activeApp]);

  if (selection.kind === 'app') {
    if (!activeApp) {
      return <MissingAppFallback />;
    }
    return (
      <div
        aria-labelledby={`workspace-app-tab-${activeApp.id}`}
        className="h-full"
        id={`workspace-app-panel-${activeApp.id}`}
        role="tabpanel"
      >
        {activeAppBody}
      </div>
    );
  }

  const tab = tabs.find((t) => t.id === selection.tabId);
  if (!tab) {
    // Selected tab vanished (e.g. closed via cleanup). Render a friendly empty state.
    return <NoFileTabSelected />;
  }
  const status = tabStatuses.get(tab.compositeKey);
  const isLoading = loadingFiles.has(tab.compositeKey);
  const content = fileContents[tab.compositeKey];
  return (
    <div
      aria-labelledby={`workspace-file-tab-${tab.id}`}
      className="h-full"
      id={`workspace-file-panel-${tab.id}`}
      role="tabpanel"
    >
      <FileTabBody
        content={content}
        isLoading={isLoading}
        isRestoring={isRestoring}
        status={status}
        tab={tab}
      />
    </div>
  );
});

interface FileTabBodyProps {
  readonly content: string | undefined;
  readonly isLoading: boolean;
  readonly isRestoring: boolean;
  readonly status: TabFileStatus | undefined;
  readonly tab: FileTab;
}

function FileTabBody({ tab, content, isLoading, isRestoring, status }: FileTabBodyProps) {
  const path = useMemo(() => {
    try {
      return decodeFileSelection(tab.compositeKey).path;
    } catch {
      return tab.path;
    }
  }, [tab.compositeKey, tab.path]);

  const getScrollTop = useEditorViewStateStore((s) => s.getScrollTop);
  const setScrollTop = useEditorViewStateStore((s) => s.setScrollTop);
  const preRef = useRef<HTMLPreElement | null>(null);

  // biome-ignore lint/plugin: DOM scroll-restore effect — restores per-tab scroll offset on switch
  useEffect(() => {
    const el = preRef.current;
    if (el) {
      el.scrollTop = getScrollTop(tab.compositeKey);
    }
  }, [tab.compositeKey, getScrollTop]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLPreElement>) => {
      setScrollTop(tab.compositeKey, e.currentTarget.scrollTop);
    },
    [setScrollTop, tab.compositeKey]
  );

  if (status?.status === 'needs-permission') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div aria-live="polite" className="sr-only">
          File access required for {path}. Click the tab to restore access.
        </div>
        <LockKeyhole aria-hidden="true" className="mb-4 h-12 w-12 text-amber-500" />
        <p className="font-semibold text-lg">File Access Required</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          Click the tab again to restore access to this file. Your browser requires permission to
          read files after a page reload.
        </p>
        {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
      </div>
    );
  }

  if (status?.status === 'not-found') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div aria-live="polite" className="sr-only">
          File not found: {path}. This file may have been moved, renamed, or deleted.
        </div>
        <AlertCircle aria-hidden="true" className="mb-4 h-12 w-12 text-destructive" />
        <p className="font-semibold text-lg">File Not Found</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          This file could not be restored. It may have been moved, renamed, or deleted.
        </p>
        <p className="mt-1 text-muted-foreground text-xs">{path}</p>
        {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
      </div>
    );
  }

  if (typeof content !== 'string') {
    // Three reasons content may be missing here, none of which is "the file is gone":
    //  1. Restoration is still in flight (status not yet emitted).
    //  2. We just opened the tab and loadFileContent hasn't completed.
    //  3. The active tab effect hasn't fired yet (e.g. fileTree not ready on web).
    // In all cases, "Restoring…" is the honest message — "File not found" was a lie.
    const isPending = isLoading || isRestoring || status?.status === 'pending';
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>{isPending ? 'Restoring…' : 'Loading…'}</span>
      </div>
    );
  }

  // Short-circuit before truncation: the inaccessible branch renders the full `content`
  // verbatim, so running getDisplayContent first would do throwaway work and (for a very
  // verbose error message above MAX_DOM_CHARS) produce an unused truncated string.
  if (content.startsWith(INACCESSIBLE_CONTENT_PREFIX)) {
    return (
      <div className="h-full overflow-auto p-4">
        <p className="text-amber-600 dark:text-amber-400">{content}</p>
        <p className="mt-2 text-muted-foreground text-sm">
          To access this file, please open the folder again using the folder icon button. This is a
          security measure of your browser.
        </p>
      </div>
    );
  }

  const { text, truncated } = getDisplayContent(content);

  return (
    <pre
      className="h-full overflow-auto whitespace-pre-wrap bg-muted/40 p-4 font-mono text-sm"
      data-truncated={truncated ? 'true' : 'false'}
      onScroll={onScroll}
      ref={preRef}
    >
      {text}
    </pre>
  );
}

function NoFileTabSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <p className="font-semibold">No file selected</p>
      <p className="text-sm">Click on a file in the Explorer to open it here.</p>
    </div>
  );
}

function MissingAppFallback() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <p className="font-semibold">App unavailable</p>
      <p className="text-sm">No registered workspace app matches the saved selection.</p>
    </div>
  );
}

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

/**
 * Whether this bundle is running inside the Electron renderer (the desktop app exposes
 * `window.electronAPI` via preload). Called from event handlers, not module init —
 * evaluating at module-load time would race against the preload script, leaving the
 * value `false` for an entire session if this module imports before preload completes.
 * The cost of a lazy property check on each Cmd+W press is negligible.
 */
function isDesktopRenderer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as Window & { electronAPI?: unknown }).electronAPI !== 'undefined'
  );
}

/** Hard cap on how much text we paint into the DOM per panel. Beyond this we truncate visibly. */
const MAX_DOM_CHARS = 200_000;

function getDisplayContent(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_DOM_CHARS) {
    return { text: raw, truncated: false };
  }
  const suffix = '\n\n… truncated for display …';
  // Math.max guards against a future where suffix grows past MAX_DOM_CHARS — slice()
  // would silently flip the index sign and produce surprising output otherwise.
  let end = Math.max(0, MAX_DOM_CHARS - suffix.length);
  // Avoid splitting a UTF-16 surrogate pair (e.g. emoji or supplementary CJK at the
  // cut boundary) which would render as a replacement character.
  const HighSurrogateStart = 0xd8_00;
  const HighSurrogateEnd = 0xdb_ff;
  if (
    end > 0 &&
    end < raw.length &&
    raw.charCodeAt(end - 1) >= HighSurrogateStart &&
    raw.charCodeAt(end - 1) <= HighSurrogateEnd
  ) {
    end -= 1;
  }
  return { text: raw.slice(0, end) + suffix, truncated: true };
}
