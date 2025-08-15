import { create } from 'zustand';
import { isFileExplorerV2Enabled, shouldUseFileExplorerWorker } from '../feature-flags';
import { LazyTreeClient } from '../lazy-tree-client';
import type {
  FilterSpec,
  TreeNode,
  VisibleRow,
  VisibleSplice,
  WorkerMetrics,
} from '../lazy-tree-protocol';
import { computeVisibleRows } from '../visible-rows';
import { applySplicesImmutable, dispatchVisibleRowsUpdated } from '../visible-splices';

type ExplorerState = {
  // data
  tree: TreeNode[];
  expanded: Set<string>;
  filter: FilterSpec | undefined;
  visible: VisibleRow[];

  // worker
  useWorker: boolean;
  worker: LazyTreeClient | null | undefined;
  metrics: WorkerMetrics | undefined;

  // actions
  init(params: { tree: TreeNode[]; expanded?: Iterable<string>; filter?: FilterSpec }): void;
  replaceTree(tree: TreeNode[]): void;
  expandNode(path: string): void;
  collapseNode(path: string): void;
  toggleNode(path: string): void;
  applyFilter(filter?: FilterSpec): void;
  teardown(): void;
};

// no-op helper retained for possible future checks

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  tree: [],
  expanded: new Set<string>(),
  filter: undefined as FilterSpec | undefined,
  visible: [],
  useWorker: false,
  worker: null as LazyTreeClient | null,
  metrics: undefined as WorkerMetrics | undefined,

  init({ tree, expanded, filter }) {
    const useWorker = shouldUseFileExplorerWorker(() => isFileExplorerV2Enabled());
    const expandedSet = new Set(expanded ?? []);
    // optimistic local visible
    const localVisible = computeVisibleRows(tree, expandedSet, filter);

    // always set base state first
    set({ tree, expanded: expandedSet, filter, visible: localVisible, useWorker });

    if (!useWorker) {
      dispatchVisibleRowsUpdated(localVisible);
      return;
    }

    // Create worker once
    const client = new LazyTreeClient({
      onVisibleFull: (rows, metrics) => {
        set({ visible: rows, metrics });
        dispatchVisibleRowsUpdated(rows);
      },
      onVisibleSplices: (splices, metrics) => {
        set((s) => {
          const next = applySplicesImmutable(
            s.visible,
            splices as (VisibleSplice & { items: VisibleRow[] })[]
          );
          dispatchVisibleRowsUpdated(next);
          return { visible: next, metrics };
        });
      },
      onError: (e) => console.warn('[FileTree V2 worker error]', e),
    });

    set({ worker: client });
    // seed worker
    client.initTree(tree, Array.from(expandedSet), filter).catch(() => {});
  },

  replaceTree(nextTree) {
    const { useWorker, worker, expanded, filter } = get();
    if (useWorker && worker) {
      worker.replaceTree(nextTree).catch(() => {});
      set({ tree: nextTree }); // visible will be updated via splice/full callback
    } else {
      const visible = computeVisibleRows(nextTree, expanded, filter);
      set({ tree: nextTree, visible });
      dispatchVisibleRowsUpdated(visible);
    }
  },

  expandNode(path) {
    const { expanded, tree, filter, useWorker, worker } = get();
    if (expanded.has(path)) return; // idempotent
    const nextExpanded = new Set(expanded).add(path);
    set({ expanded: nextExpanded });

    if (useWorker && worker) {
      worker.expand(path).catch(() => {});
    } else {
      const visible = computeVisibleRows(tree, nextExpanded, filter);
      set({ visible });
      dispatchVisibleRowsUpdated(visible);
    }
  },

  collapseNode(path) {
    const { expanded, tree, filter, useWorker, worker } = get();
    if (!expanded.has(path)) return;
    const nextExpanded = new Set(expanded);
    nextExpanded.delete(path);
    set({ expanded: nextExpanded });

    if (useWorker && worker) {
      worker.collapse(path).catch(() => {});
    } else {
      const visible = computeVisibleRows(tree, nextExpanded, filter);
      set({ visible });
      dispatchVisibleRowsUpdated(visible);
    }
  },

  toggleNode(path) {
    const { expanded } = get();
    if (expanded.has(path)) get().collapseNode(path);
    else get().expandNode(path);
  },

  applyFilter(nextFilter) {
    const { useWorker, worker, tree, expanded } = get();
    set({ filter: nextFilter });

    if (useWorker && worker) {
      worker.applyFilter(nextFilter ?? {}).catch(() => {});
    } else {
      const visible = computeVisibleRows(tree, expanded, nextFilter);
      set({ visible });
      dispatchVisibleRowsUpdated(visible);
    }
  },

  teardown() {
    const { worker } = get();
    try {
      worker?.teardown();
    } catch {}
    set({ worker: null });
  },
}));
