import type {
  WorkspaceSnapshotEditor,
  WorkspaceSnapshotFileTab,
  WorkspaceSnapshotPane,
  WorkspaceSnapshotSelection,
  WorkspaceSnapshotV1,
} from '@brainstrike/assistant-data';

/**
 * Pure serialize/hydrate between the LIVE workspace stores and a
 * `WorkspaceSnapshotV1` (BST-1268). The facade keeps this module free of
 * store imports so capture/apply are unit-testable and the coordinator owns
 * exactly one binding to the real stores.
 *
 * Capture prunes editor state to OPEN tabs (bounded growth) and partitions
 * the workspace-global expansion set per root by longest-prefix over the
 * root descriptors' paths — unmatched paths (e.g. web-relative roots) ride in
 * the '' bucket so nothing is dropped. Apply UNIONS the buckets back into ONE
 * fresh Set, because expansion state is one workspace-global set by contract
 * and `setExpandedPaths` adopts the caller's Set without cloning.
 */
export interface WorkspaceStateFacade {
  applyApps(openAppIds: readonly string[], selection: WorkspaceSnapshotSelection): void;
  applyEditorState(compositeKey: string, editor: WorkspaceSnapshotEditor): void;
  /** Receives a FRESH Set the store may adopt. */
  applyExpandedPaths(paths: Set<string>): void;
  applyExplorerScrollTop(scrollTop: number | undefined): void;
  applyFileTabs(tabs: readonly WorkspaceSnapshotFileTab[], activeTabId: string | null): void;
  /**
   * WHOLESALE pane replacement (BST-1269): keys absent from the record are
   * dropped by the receiving store. Panes are per-thread state; per-key
   * application would leak the previous thread's panes across a switch.
   */
  applyPanes(panes: Readonly<Record<string, WorkspaceSnapshotPane>>): void;
  applyRootViews(focusedRootId: string | null, visibleRootIds: readonly string[] | null): void;
  /** Close app tabs; the selection store hands a closed selection to its successor. */
  closeApps(appIds: readonly string[]): void;
  getEditorState(compositeKey: string): WorkspaceSnapshotEditor;
  getExpandedDirectoryPaths(): ReadonlySet<string>;
  getExplorerScrollTop(): number | undefined;
  getFileTabs(): { activeTabId: string | null; tabs: readonly WorkspaceSnapshotFileTab[] };
  getFocusedRootId(): string | null;
  getOpenAppIds(): readonly string[];
  getRootDescriptors(): Readonly<Record<string, { readonly path: string }>>;
  getSelection(): WorkspaceSnapshotSelection;
  getVisibleRootIds(): readonly string[] | null;
}

function isWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function partitionExpansionsByRoot(
  expandedPaths: ReadonlySet<string>,
  rootDescriptors: Readonly<Record<string, { readonly path: string }>>
): Record<string, { expandedPaths: string[] }> {
  // Longest root path wins so nested roots attribute to the deepest match.
  const roots = Object.entries(rootDescriptors)
    .filter(([, descriptor]) => descriptor.path.length > 0)
    .sort((a, b) => b[1].path.length - a[1].path.length);
  const byRoot: Record<string, { expandedPaths: string[] }> = {};
  for (const path of expandedPaths) {
    const match = roots.find(([, descriptor]) => isWithinRoot(path, descriptor.path));
    const bucket = match ? match[0] : '';
    let entry = byRoot[bucket];
    if (!entry) {
      entry = { expandedPaths: [] };
      byRoot[bucket] = entry;
    }
    entry.expandedPaths.push(path);
  }
  return byRoot;
}

export function captureWorkspaceSnapshot(facade: WorkspaceStateFacade): WorkspaceSnapshotV1 {
  const fileTabs = facade.getFileTabs();
  const editors: Record<string, WorkspaceSnapshotEditor> = {};
  for (const tab of fileTabs.tabs) {
    editors[tab.compositeKey] = facade.getEditorState(tab.compositeKey);
  }
  const scrollTop = facade.getExplorerScrollTop();
  return {
    apps: {
      openAppIds: [...facade.getOpenAppIds()],
      selection: facade.getSelection(),
    },
    editors,
    explorer: {
      byRoot: partitionExpansionsByRoot(
        facade.getExpandedDirectoryPaths(),
        facade.getRootDescriptors()
      ),
      ...(scrollTop === undefined ? {} : { scrollTop }),
    },
    fileTabs: {
      activeTabId: fileTabs.activeTabId,
      tabs: fileTabs.tabs.map((tab) => ({ compositeKey: tab.compositeKey, path: tab.path })),
    },
    roots: {
      focusedRootId: facade.getFocusedRootId(),
      visibleRootIds: facade.getVisibleRootIds(),
    },
    version: 1,
  };
}

export function applyWorkspaceSnapshot(
  snapshot: WorkspaceSnapshotV1,
  facade: WorkspaceStateFacade
): void {
  facade.applyApps(snapshot.apps.openAppIds, snapshot.apps.selection);
  facade.applyFileTabs(snapshot.fileTabs.tabs, snapshot.fileTabs.activeTabId);

  const expandedUnion = new Set<string>();
  for (const bucket of Object.values(snapshot.explorer.byRoot)) {
    for (const path of bucket.expandedPaths) {
      expandedUnion.add(path);
    }
  }
  facade.applyExpandedPaths(expandedUnion);
  facade.applyExplorerScrollTop(snapshot.explorer.scrollTop);
  facade.applyRootViews(snapshot.roots.focusedRootId, snapshot.roots.visibleRootIds);
  const panes: Record<string, WorkspaceSnapshotPane> = {};
  for (const [compositeKey, editor] of Object.entries(snapshot.editors)) {
    facade.applyEditorState(compositeKey, editor);
    if (editor.pane) {
      panes[compositeKey] = editor.pane;
    }
  }
  facade.applyPanes(panes);
}
