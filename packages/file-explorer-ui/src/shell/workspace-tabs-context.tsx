import {
  type ActionOutcome,
  createClosedTabHistory,
  NO_CLOSED_TAB_ERROR,
  type OpenTab,
  placeTabAtIndex,
  recordRemovedTabs,
} from '@brainstrike/context-actions';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useTabFileRestoration } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import { type OpenFileInTab, useIdeFileEditor } from '@brainstrike/ui';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import { useTabManager } from '../hooks/use-tab-manager';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';
import { useTabManagerStore } from '../stores/tab-manager-store';
import { useWorkspaceTabSelectionStore } from '../stores/workspace-tab-selection-store';
import { useFileExplorerStoreSelector } from './file-explorer-provider';
import { useFileExplorer } from './use-file-explorer-context';
import { useTerminalHotkey } from './use-terminal-hotkey';
import { useWorkspaceOpenFileRefresh } from './use-workspace-open-file-refresh';
import {
  useWorkspaceTabs,
  type WorkspaceTabRef,
  WorkspaceTabsContext,
  type WorkspaceTabsValue,
} from './use-workspace-tabs';
import type { WorkspaceApp } from './workspace-app';
import { getFileName, getTabRootPath } from './workspace-tab-utils';

const logger = createLogger('WorkspaceTabs');

/** A closed workspace tab, remembered for Reopen Closed Tab (session-only). */
type WorkspaceClosedTab =
  | { readonly appId: string; readonly kind: 'app'; readonly label: string }
  | { readonly compositeKey: string; readonly kind: 'file'; readonly name: string };

function liveFileTabIds(): readonly string[] {
  return useTabManagerStore.getState().tabs.map((tab) => tab.id);
}

/**
 * Registers the workspace open-file handler into the NEAREST IdeFileEditorContext.
 * Mount this INSIDE the outer IdeLayout (the one whose header hosts the strip) —
 * the provider itself sits above the layout and cannot reach the seam.
 */
export function WorkspaceOpenFileBridge(): null {
  const { handleOpenFileInTab } = useWorkspaceTabs();
  const { registerOpenFileInTab } = useIdeFileEditor();
  useEffect(() => {
    registerOpenFileInTab(handleOpenFileInTab);
  }, [registerOpenFileInTab, handleOpenFileInTab]);
  return null;
}

export interface WorkspaceTabsProviderProps {
  /**
   * App registry in canonical display order (e.g. Files, Changes, Canvas).
   * Capability gating happens at the call site by omission — an app absent
   * from this list has no tab, no launcher card, and no stub.
   */
  readonly apps: readonly WorkspaceApp[];
  readonly children: ReactNode;
}

function canAutoLoadFileContent(
  canLoadWithoutTree: boolean,
  compositeKey: string,
  fileTreeLength: number,
  rootDescriptors: Readonly<Record<string, unknown>>
): boolean {
  if (!canLoadWithoutTree) {
    return fileTreeLength > 0;
  }
  const { folderId } = decodeFileSelection(compositeKey);
  return rootDescriptors[folderId] !== undefined;
}

/**
 * Owns all workspace tab orchestration (BST-1258): file-tab lifecycle,
 * restoration/permission flows, app open/close/singleton semantics, selection
 * reconciliation, closed-tab history, and the Terminal hotkey. Tab chords are
 * app-shell's focus-scoped router (BST-1842), driven through `onActivateTab`,
 * `onCloseTab` and `onReopenClosedTab`. The strip (panel header) and body (panel
 * content) render in SIBLING subtrees, so this provider sits above the outer
 * IdeLayout and both consume it through context; all durable state lives in
 * the zustand stores (tab-manager, workspace-tab-selection), written directly
 * by event handlers — never local state synced by effects (React Doctor
 * `no-adjust-state-on-prop-change`, enforced twice on this surface).
 */
export function WorkspaceTabsProvider({
  apps,
  children,
}: WorkspaceTabsProviderProps): ReactElement {
  const { tabs, openTab, closeTab, setActiveTab, clearTabs } = useTabManager();
  const closeOtherTabs = useTabManagerStore((state) => state.closeOtherTabs);
  const closeTabsToRight = useTabManagerStore((state) => state.closeTabsToRight);
  const reorderTabs = useTabManagerStore((state) => state.reorderTabs);
  const fileContentLoadAuthority = useFileContentLoadAuthority();
  const retainedErrorOwnerRef = useRef<object>({});

  // The durable terminal-error projection belongs to the exact open-tab set.
  // Subscribe below React so tab actions, external hydration, and the 20-tab
  // eviction limit retire their keys synchronously before another read starts.
  useLayoutEffect(() => {
    const owner = retainedErrorOwnerRef.current;
    const syncRetainedErrorKeys = (): void => {
      fileContentLoadAuthority.setRetainedErrorKeys(
        owner,
        useTabManagerStore.getState().tabs.map((tab) => tab.compositeKey)
      );
    };
    syncRetainedErrorKeys();
    const unsubscribe = useTabManagerStore.subscribe(syncRetainedErrorKeys);
    return () => {
      unsubscribe();
      fileContentLoadAuthority.setRetainedErrorKeys(owner, []);
    };
  }, [fileContentLoadAuthority]);

  const {
    canLoadWithoutTree,
    fileContentErrors,
    fileContents,
    fileTree,
    loadFileContent,
    loadingFiles,
    reloadFileContents,
  } = useFileExplorer();
  const startFileContentLoad = useCallback(
    (compositeKey: string): void => {
      void loadFileContent(compositeKey, 'interactive').catch((error: unknown) => {
        logger.error('Workspace file-content load failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          fileCount: 1,
        });
      });
    },
    [loadFileContent]
  );
  const handleRetryFileContent = useCallback(
    (compositeKey: string): void => {
      void reloadFileContents([compositeKey], 'interactive').catch((error: unknown) => {
        logger.error('Workspace file-content retry failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          fileCount: 1,
        });
      });
    },
    [reloadFileContents]
  );
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);

  const selection = useWorkspaceTabSelectionStore((s) => s.selection);
  const openAppIds = useWorkspaceTabSelectionStore((s) => s.openAppIds);
  const mountedAppIdList = useWorkspaceTabSelectionStore((s) => s.mountedAppIds);
  const openApp = useWorkspaceTabSelectionStore((s) => s.openApp);
  const closeApp = useWorkspaceTabSelectionStore((s) => s.closeApp);
  const closeApps = useWorkspaceTabSelectionStore((s) => s.closeApps);
  const selectEmpty = useWorkspaceTabSelectionStore((s) => s.selectEmpty);
  const selectFile = useWorkspaceTabSelectionStore((s) => s.selectFile);
  const selectionIntentRef = useRef(0);
  /**
   * Invalidate any in-flight async tab selection (the permission-prompt await
   * in `handleSelectFileTab`). EVERY selection-mutating path must call this
   * before writing — review finding: the file-tab paths (close, bulk close,
   * openFileInTab) skipped it, letting a resolved permission prompt clobber a
   * newer selection with a possibly-closed tab.
   */
  const invalidatePendingSelection = useCallback(() => {
    selectionIntentRef.current += 1;
  }, []);

  const openApps = useMemo(() => {
    // Dev-mode assertion: WorkspaceApp.id is used as a tab dom id and as the
    // persistence key for open/active apps, so collisions cause silent UI bugs
    // (clicking one tab selects another) rather than visible errors.
    if (process.env['NODE_ENV'] !== 'production') {
      const seen = new Set<string>();
      for (const app of apps) {
        if (seen.has(app.id)) {
          logger.error('Duplicate WorkspaceApp id detected — apps must have unique ids', {
            duplicateId: app.id,
          });
        }
        seen.add(app.id);
      }
    }
    const openIdSet = new Set(openAppIds);
    return apps.filter((app) => openIdSet.has(app.id));
  }, [apps, openAppIds]);
  const mountedAppIds = useMemo(() => new Set(mountedAppIdList), [mountedAppIdList]);

  // Restoration plumbing: surfaces persisted-tab status (restored / needs-permission /
  // not-found). Deliberately NO close callback (BST-1263): a missing file's tab stays
  // in the strip with `not-found` status so the user sees the deletion instead of a
  // silently vanished tab.
  const { tabStatuses, requestTabPermission, getStatusMessage, isRestoring } =
    useTabFileRestoration(tabs);

  useWorkspaceOpenFileRefresh({ reloadFileContents, tabs });

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
  // on shallow-equal props.
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
          startFileContentLoad(compositeKey);
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
    [requestTabPermission, startFileContentLoad]
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
          error: err instanceof Error ? err.message : String(err),
          tabId,
        });
      }
    },
    [ensurePermissionForTab, setActiveTab, selectFile]
  );

  const handleOpenApp = useCallback(
    (appId: string) => {
      invalidatePendingSelection();
      openApp(appId);
    },
    [invalidatePendingSelection, openApp]
  );

  /**
   * Route the selection somewhere sensible when the current one goes away:
   * first OPEN registered app, else the launcher's empty state. Reads the
   * registry through `apps` and the open list from the store at call time.
   */
  const fallbackToOpenApp = useCallback(() => {
    invalidatePendingSelection();
    const currentOpenIds = new Set(useWorkspaceTabSelectionStore.getState().openAppIds);
    const firstOpenApp = apps.find((app) => currentOpenIds.has(app.id));
    if (firstOpenApp) {
      openApp(firstOpenApp.id);
    } else {
      selectEmpty();
    }
  }, [apps, invalidatePendingSelection, openApp, selectEmpty]);

  /**
   * The store falls back app→app or app→empty on its own; when it landed on
   * empty but file tabs remain, prefer the most recent file tab over the
   * launcher (the store cannot see file tabs).
   */
  const preferActiveFileTabOverEmpty = useCallback(
    (appSuccessor: string | null): void => {
      if (appSuccessor !== null) {
        return;
      }
      if (useWorkspaceTabSelectionStore.getState().selection.kind !== 'empty') {
        return;
      }
      const { activeTabId } = useTabManagerStore.getState();
      if (activeTabId !== null) {
        selectFile(activeTabId);
      }
    },
    [selectFile]
  );

  // Every close path (✕, Delete, the menus, chords) records what it closed, so
  // Reopen Closed Tab can restore it. Session-only: the history lives and dies
  // with this provider, so it needs no factory-reset wiring.
  const [closedTabs] = useState(() => createClosedTabHistory<WorkspaceClosedTab>());
  /** Run an app close, then record exactly the app tabs it removed. */
  const closeAppsRecorded = useCallback(
    (close: () => void): void => {
      const openAppTabs = (): readonly OpenTab<WorkspaceClosedTab>[] => {
        const open = new Set(useWorkspaceTabSelectionStore.getState().openAppIds);
        return apps.flatMap((app): OpenTab<WorkspaceClosedTab>[] =>
          open.has(app.id)
            ? [{ id: app.id, tab: { appId: app.id, kind: 'app', label: app.label } }]
            : []
        );
      };
      const before = openAppTabs();
      close();
      recordRemovedTabs(
        closedTabs,
        before,
        openAppTabs().map((app) => app.id)
      );
    },
    [apps, closedTabs]
  );
  /** Run a file-tab close, then record exactly the file tabs it removed. */
  const closeFilesRecorded = useCallback(
    (close: () => void): void => {
      const before = useTabManagerStore.getState().tabs.map(
        (tab): OpenTab<WorkspaceClosedTab> => ({
          id: tab.id,
          tab: { compositeKey: tab.compositeKey, kind: 'file', name: getFileName(tab.path) },
        })
      );
      close();
      recordRemovedTabs(closedTabs, before, liveFileTabIds());
    },
    [closedTabs]
  );

  const handleCloseApp = useCallback(
    (appId: string) =>
      closeAppsRecorded(() => {
        invalidatePendingSelection();
        preferActiveFileTabOverEmpty(closeApp(appId));
      }),
    [closeApp, closeAppsRecorded, invalidatePendingSelection, preferActiveFileTabOverEmpty]
  );

  const handleCloseApps = useCallback(
    (appIds: readonly string[]) =>
      closeAppsRecorded(() => {
        invalidatePendingSelection();
        preferActiveFileTabOverEmpty(closeApps(appIds));
      }),
    [closeApps, closeAppsRecorded, invalidatePendingSelection, preferActiveFileTabOverEmpty]
  );

  const closeFileTab = useCallback(
    (tabId: string) => {
      invalidatePendingSelection();
      // closeTab returns the successor activeTabId (or null if no tabs remain), so we
      // mirror that into the workspace selection without any implicit dependency on
      // Zustand's synchronous-set contract. We read selection from the store directly
      // (instead of closing over `selection`) so this callback's identity stays stable
      // across selection changes.
      const currentSelection = useWorkspaceTabSelectionStore.getState().selection;
      const closingActive = currentSelection.kind === 'file' && currentSelection.tabId === tabId;
      const successorId = closeTab(tabId);
      if (!closingActive) {
        return;
      }
      if (successorId === null) {
        fallbackToOpenApp();
      } else {
        selectFile(successorId);
      }
    },
    [closeTab, fallbackToOpenApp, invalidatePendingSelection, selectFile]
  );
  const handleCloseFileTab = useCallback(
    (tabId: string) => closeFilesRecorded(() => closeFileTab(tabId)),
    [closeFileTab, closeFilesRecorded]
  );

  // If the workspace points at something that no longer exists — a file tab that
  // was evicted/closed externally, or an app selection whose app is not in this
  // build's registry (e.g. desktop-persisted Changes opened on web) — route back
  // to an open app or the launcher so downstream operations (cycle, close,
  // hotkey targets) never act on stale references.
  useEffect(() => {
    if (selection.kind === 'file') {
      if (!tabs.some((t) => t.id === selection.tabId)) {
        fallbackToOpenApp();
      }
      return;
    }
    if (selection.kind === 'app' && !apps.some((app) => app.id === selection.appId)) {
      fallbackToOpenApp();
    }
  }, [selection, tabs, apps, fallbackToOpenApp]);

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
    if (
      !canAutoLoadFileContent(
        canLoadWithoutTree,
        tab.compositeKey,
        fileTree.length,
        rootDescriptors
      )
    ) {
      return;
    }
    if (fileContents[tab.compositeKey] !== undefined) {
      return;
    }
    if (loadingFiles.has(tab.compositeKey)) {
      return;
    }
    // A terminal per-key failure is an explicit retry boundary. Re-entering
    // the automatic loader as soon as loading clears would create an unbounded
    // fail/render/retry loop and could erase the visible error without user or
    // filesystem activity. The next canonical refresh clears this key's error
    // at the logical request boundary and performs the retry.
    if (fileContentErrors.has(tab.compositeKey)) {
      return;
    }
    const status = tabStatuses.get(tab.compositeKey);
    // Skip auto-load if the tab needs an explicit user gesture for permission.
    if (status && status.status !== 'restored') {
      return;
    }
    startFileContentLoad(tab.compositeKey);
  }, [
    selection,
    tabs,
    fileContents,
    fileContentErrors,
    loadingFiles,
    tabStatuses,
    canLoadWithoutTree,
    fileTree,
    rootDescriptors,
    startFileContentLoad,
  ]);

  // Sync the latest snapshots into refs so the open-file callback can read them without
  // listing them as deps (which would re-register on every load tick).
  const fileContentsRef = useRef(fileContents);
  const loadingFilesRef = useRef(loadingFiles);
  useEffect(() => {
    fileContentsRef.current = fileContents;
    loadingFilesRef.current = loadingFiles;
  }, [fileContents, loadingFiles]);

  const setTarget = useEditorViewStateStore((s) => s.setTarget);
  const handleOpenFileInTab = useCallback<OpenFileInTab>(
    (compositeKey, options) => {
      // Decode defensively — keys come from trusted internal callers today, but a
      // malformed key would otherwise propagate as an unhandled error from the click
      // event. FileTabBody wraps the same call in try/catch; mirror that here.
      let path: string;
      try {
        ({ path } = decodeFileSelection(compositeKey));
      } catch (err) {
        logger.error('Invalid compositeKey passed to openFileInTab', {
          compositeKey,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Record the one-shot view target BEFORE mounting the tab so FileTabBody's
      // CodeSurface reads it on its first (keyed) render. A later open of the same
      // key overwrites it; there is no reopen-with-new-line remount in v1. A chunk
      // open carries a selection range (scroll to + select the block); a match
      // open carries the line only.
      if (typeof options?.line === 'number' && options.line > 0) {
        const line = options.line;
        setTarget(
          compositeKey,
          options.selection ? { line, selection: options.selection } : { line }
        );
      }
      // tabId is the compositeKey itself — stable across reloads (it already encodes the
      // folder identity), unlike the legacy `${rootFolderId}:${compositeKey}` form.
      const tabId = compositeKey;
      invalidatePendingSelection();
      openTab(path, tabId, compositeKey);
      selectFile(tabId);
      if (
        fileContentsRef.current[compositeKey] === undefined &&
        !loadingFilesRef.current.has(compositeKey)
      ) {
        startFileContentLoad(compositeKey);
      }
    },
    [openTab, selectFile, startFileContentLoad, setTarget, invalidatePendingSelection]
  );

  useTerminalHotkey(apps, handleOpenApp);

  const reconcileSelectionAfterBulkClose = useCallback(
    (nextActiveTabId: string | null): void => {
      invalidatePendingSelection();
      const currentSelection = useWorkspaceTabSelectionStore.getState().selection;
      if (currentSelection.kind !== 'file') {
        return;
      }
      const selectedTabStillExists = useTabManagerStore
        .getState()
        .tabs.some((tab) => tab.id === currentSelection.tabId);
      if (selectedTabStillExists) {
        return;
      }
      if (nextActiveTabId === null) {
        fallbackToOpenApp();
        return;
      }
      selectFile(nextActiveTabId);
    },
    [fallbackToOpenApp, invalidatePendingSelection, selectFile]
  );

  // File-tab bulk operations never replace an app selection. When a file
  // selection is removed, reconcile it immediately instead of waiting for the
  // dead-selection safety effect on the next render.
  const handleCloseAllFileTabs = useCallback(
    () =>
      closeFilesRecorded(() => {
        clearTabs();
        reconcileSelectionAfterBulkClose(null);
      }),
    [clearTabs, closeFilesRecorded, reconcileSelectionAfterBulkClose]
  );

  const handleCloseOtherFileTabs = useCallback(
    (tabId: string): void =>
      closeFilesRecorded(() => {
        const nextActiveTabId = closeOtherTabs(tabId);
        reconcileSelectionAfterBulkClose(nextActiveTabId);
      }),
    [closeFilesRecorded, closeOtherTabs, reconcileSelectionAfterBulkClose]
  );

  const handleCloseFileTabsToRight = useCallback(
    (tabId: string): void =>
      closeFilesRecorded(() => {
        const nextActiveTabId = closeTabsToRight(tabId);
        reconcileSelectionAfterBulkClose(nextActiveTabId);
      }),
    [closeFilesRecorded, closeTabsToRight, reconcileSelectionAfterBulkClose]
  );

  const openAppIdSet = useMemo(() => new Set(openApps.map((app) => app.id)), [openApps]);
  const handleActivateTab = useCallback(
    (id: string): void => {
      if (openAppIdSet.has(id)) {
        handleOpenApp(id);
        return;
      }
      void handleSelectFileTab(id);
    },
    [handleOpenApp, handleSelectFileTab, openAppIdSet]
  );
  const handleCloseTab = useCallback(
    (id: string): void => {
      if (openAppIdSet.has(id)) {
        handleCloseApp(id);
        return;
      }
      handleCloseFileTab(id);
    },
    [handleCloseApp, handleCloseFileTab, openAppIdSet]
  );

  const handleReopenClosedTab = useCallback((): Promise<ActionOutcome> => {
    const closed = closedTabs.pop();
    if (!closed) {
      return Promise.resolve({ error: NO_CLOSED_TAB_ERROR, ok: false });
    }
    const entry = closed.tab;
    if (entry.kind === 'app') {
      if (!apps.some((app) => app.id === entry.appId)) {
        return Promise.resolve({
          error: `${entry.label} can no longer be reopened: it is not available`,
          ok: false,
        });
      }
      handleOpenApp(entry.appId);
      return Promise.resolve({ ok: true });
    }
    if (getTabRootPath(entry, rootDescriptors) === null) {
      return Promise.resolve({
        error: `"${entry.name}" can no longer be reopened: its folder is not connected`,
        ok: false,
      });
    }
    const wasOpen = liveFileTabIds().includes(entry.compositeKey);
    handleOpenFileInTab(entry.compositeKey);
    if (!wasOpen) {
      reorderTabs(placeTabAtIndex(liveFileTabIds(), entry.compositeKey, closed.index));
    }
    return Promise.resolve({ ok: true });
  }, [apps, closedTabs, handleOpenApp, handleOpenFileInTab, reorderTabs, rootDescriptors]);

  const tabOrder = useMemo<readonly WorkspaceTabRef[]>(() => {
    const pinned: WorkspaceTabRef[] = [];
    const dynamic: WorkspaceTabRef[] = [];
    for (const app of openApps) {
      (app.placement === 'pinned' ? pinned : dynamic).push({ id: app.id, label: app.label });
    }
    const files = tabs.map((tab) => ({ id: tab.id, label: getFileName(tab.path) }));
    return [...pinned, ...dynamic, ...files];
  }, [openApps, tabs]);

  const value = useMemo<WorkspaceTabsValue>(
    () => ({
      apps,
      fileContentErrors,
      fileContents,
      getTabStatusMessage: getStatusMessage,
      handleOpenFileInTab,
      isRestoring,
      loadingFiles,
      mountedAppIds,
      onActivateTab: handleActivateTab,
      onCloseAllFileTabs: handleCloseAllFileTabs,
      onCloseApp: handleCloseApp,
      onCloseApps: handleCloseApps,
      onCloseFileTab: handleCloseFileTab,
      onCloseFileTabsToRight: handleCloseFileTabsToRight,
      onCloseOtherFileTabs: handleCloseOtherFileTabs,
      onCloseTab: handleCloseTab,
      onOpenApp: handleOpenApp,
      onReopenClosedTab: handleReopenClosedTab,
      // Reordering never writes selection, so it leaves a pending permission-prompt
      // selection alone (invalidatePendingSelection is for selection writers).
      onReorderFileTabs: reorderTabs,
      onRetryFileContent: handleRetryFileContent,
      onSelectFileTab: handleSelectFileTab,
      openApps,
      rootDescriptors,
      selection,
      tabOrder,
      tabStatuses,
      tabs,
    }),
    [
      apps,
      fileContentErrors,
      fileContents,
      getStatusMessage,
      handleOpenFileInTab,
      isRestoring,
      loadingFiles,
      mountedAppIds,
      handleActivateTab,
      handleCloseAllFileTabs,
      handleCloseApp,
      handleCloseApps,
      handleCloseFileTab,
      handleCloseFileTabsToRight,
      handleCloseOtherFileTabs,
      handleCloseTab,
      handleOpenApp,
      handleReopenClosedTab,
      handleRetryFileContent,
      handleSelectFileTab,
      openApps,
      reorderTabs,
      rootDescriptors,
      selection,
      tabOrder,
      tabs,
      tabStatuses,
    ]
  );

  return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>;
}
