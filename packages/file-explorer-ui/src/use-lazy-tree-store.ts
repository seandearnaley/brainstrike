import { create } from 'zustand';
import type { Filters, FlatRow, FromWorker, ToWorker, TreeNode } from './types/lazy-tree';

type Stats = { total: number; files: number; dirs: number; filteredOut: number };

type State = {
  rows: FlatRow[];
  expanded: Set<string>;
  totalCount: number;
  stats: Stats | null;
  filters: Filters;
  ready: boolean;
};

type Actions = {
  init(worker: Worker, tree: TreeNode[], initialExpanded?: Set<string>): void;
  setSourceTree(tree: TreeNode[]): void;
  setQuickFilter(quick: string): void;
  setFilters(filters: Partial<Filters>): void;
  expand(paths: string[]): void;
  collapse(paths: string[]): void;
  resetExpansion(): void;
  getRange(start: number, end: number): Promise<FlatRow[]>;
  teardown(): void;
};

export type LazyTreeStore = State & Actions;

export const useLazyTreeStore = create<LazyTreeStore>((set, get) => {
  let worker: Worker | null = null;

  const post = (m: ToWorker) => worker?.postMessage(m);

  const onMsg = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'VISIBLE_LIST')
      set({ rows: msg.rows, totalCount: msg.totalCount, ready: true });
    else if (msg.type === 'STATS')
      set({
        stats: { total: msg.total, files: msg.files, dirs: msg.dirs, filteredOut: msg.filteredOut },
      });
  };

  return {
    rows: [],
    expanded: new Set<string>(),
    totalCount: 0,
    stats: null,
    filters: { include: [], exclude: [], useRegex: false, quick: '' },
    ready: false,

    init(w, tree, initialExpanded = new Set<string>()) {
      if (worker && worker !== w) {
        worker.removeEventListener('message', onMsg as unknown as EventListener);
        worker.terminate();
      }
      worker = w;
      worker.addEventListener('message', onMsg as unknown as EventListener);
      set({ expanded: new Set(initialExpanded) });
      post({ type: 'SET_SOURCE_TREE', tree });
      post({ type: 'REBUILD' });
    },

    setSourceTree(tree) {
      post({ type: 'SET_SOURCE_TREE', tree });
      post({ type: 'REBUILD' });
    },

    setQuickFilter(quick) {
      const cur = get().filters;
      const next = { ...cur, quick } as Filters;
      set({ filters: next });
      post({ type: 'SET_FILTERS', filters: next });
    },

    setFilters(partial) {
      const next = { ...get().filters, ...partial } as Filters;
      set({ filters: next });
      post({ type: 'SET_FILTERS', filters: next });
    },

    expand(paths) {
      const ex = new Set(get().expanded);
      for (const p of paths) ex.add(p);
      set({ expanded: ex });
      post({ type: 'EXPAND', paths });
    },

    collapse(paths) {
      const ex = new Set(get().expanded);
      for (const p of paths) ex.delete(p);
      set({ expanded: ex });
      post({ type: 'COLLAPSE', paths });
    },

    resetExpansion() {
      set({ expanded: new Set() });
      post({ type: 'RESET_EXPANSION' });
    },

    async getRange(start, end) {
      const requestTimeoutMs = 4000;
      return new Promise<FlatRow[]>((resolve, reject) => {
        if (!worker) {
          reject(new Error('Worker not initialized'));
          return;
        }
        // Unique id based on start-end tuple and timestamp
        // Note: id reserved for future correlation; not required with (start,end) matching

        const onMessage = (e: MessageEvent<FromWorker>) => {
          if (e.data?.type !== 'RANGE_DATA') return;
          if (e.data.start !== start || e.data.end !== end) return;
          cleanup();
          resolve(e.data.rows);
        };

        const onError = () => {
          cleanup();
          reject(new Error('Worker error: getRange'));
        };

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Worker timeout: getRange'));
        }, requestTimeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          worker?.removeEventListener('message', onMessage as unknown as EventListener);
          worker?.removeEventListener('error', onError as unknown as EventListener);
          worker?.removeEventListener('messageerror', onError as unknown as EventListener);
        };

        worker.addEventListener('message', onMessage as unknown as EventListener);
        worker.addEventListener('error', onError as unknown as EventListener);
        worker.addEventListener('messageerror', onError as unknown as EventListener);
        post({ type: 'GET_RANGE', start, end });
      });
    },

    teardown() {
      worker?.removeEventListener('message', onMsg as unknown as EventListener);
      worker?.terminate();
      worker = null;
      set({ rows: [], ready: false });
    },
  };
});
