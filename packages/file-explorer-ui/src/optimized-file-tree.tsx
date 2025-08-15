import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import OptimizedFileTreeRow, { ROW_HEIGHT } from './optimized-file-tree-row';
import { useVirtualList } from './use-virtual-list';

// Worker integration (reserved for phase C)

interface IOptimizedFileTreeProps {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
}

/**
 * @file OptimizedFileTree.tsx
 * @description Optimized version of FileTree with performance improvements for large directory structures.
 *
 * Key optimizations:
 * - Uses LightweightCheckbox instead of ShadCN checkbox
 * - Improved memoization strategies
 * - Optimized React.memo comparison functions
 * - Reduced context provider overhead
 * - Enhanced virtualization with better scroll performance
 *
 * @param {IFileNode[]} fileTree - The array of IFileNode objects representing the file structure to render.
 * @param {Set<string>} loadingFiles - A set of paths for files that are currently in a loading state.
 * @param {(() => void) | undefined} onRender - An optional callback function that is triggered when the tree component renders (primarily for testing).
 * @param {string} folderId - The identifier for the current folder context, used for selection and expansion state.
 */
const OptimizedFileTree = memo<IOptimizedFileTreeProps>(
  ({ fileTree, loadingFiles, onRender, folderId }) => {
    // Centralized event names and microtask ponyfill
    const evtNudge = 'optimized-file-tree-nudge' as const;
    const evtRowsUpdated = 'v2-visible-rows-updated' as const;
    // (Removed microtask batching path)

    // Lightweight publish helper to expose visible row paths for a V2 hook
    const publishVisibleRows = useCallback(
      (rows: { path: string }[]) => {
        try {
          if (typeof window === 'undefined') return;
          const w = window as unknown as { __v2VisibleRowsPaths?: string[] };
          const paths = rows.map((r) => r.path);
          w.__v2VisibleRowsPaths = paths;
          window.dispatchEvent(new CustomEvent(evtRowsUpdated, { detail: { paths } }));
        } catch {
          // ignore
        }
      },
      [evtRowsUpdated]
    );

    // --- Workerized visible rows (feature-gated) ---
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [useWorkerV2] = useState<boolean>(() => {
      try {
        const key = 'ff_explorer_v2_worker';
        const url = new URL(
          globalThis.location?.href ?? '',
          globalThis.location?.origin ?? 'http://local'
        );
        const fromUrl = url.searchParams.get(key);
        if (fromUrl != null) return fromUrl === '1' || fromUrl.toLowerCase() === 'true';
        // localStorage override
        const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        if (ls != null) return ls === '1' || ls.toLowerCase() === 'true';
      } catch {}
      return false;
    });
    void useWorkerV2;

    // Phase B scaffolding for worker (not wired yet): keep TS happy by not declaring unused vars

    // --- Test instrumentation (enabled only in Playwright tests) ---
    // Expose feTest.visibleRecalcCount API when window.__PW_TEST__ is truthy.
    // Use layout effect so it's available before other layout effects (e.g., rebuild) run.
    useLayoutEffect(() => {
      if (typeof window === 'undefined') return;
      // biome-ignore lint/style/useNamingConvention: Playwright flag
      if (!(window as unknown as { __PW_TEST__?: boolean }).__PW_TEST__) return;
      try {
        const w = window as unknown as {
          feTest?: {
            visibleRecalcCount?: number;
            bumpVisibleRecalc?: () => void;
            getVisibleRecalcCount?: () => number;
          };
        };
        if (!w.feTest) w.feTest = {};
        if (typeof w.feTest.visibleRecalcCount !== 'number') w.feTest.visibleRecalcCount = 0;
        if (!w.feTest.bumpVisibleRecalc) {
          w.feTest.bumpVisibleRecalc = () => {
            if (!w.feTest) return;
            w.feTest.visibleRecalcCount = (w.feTest.visibleRecalcCount ?? 0) + 1;
          };
        }
        if (!w.feTest.getVisibleRecalcCount) {
          w.feTest.getVisibleRecalcCount = () => w.feTest?.visibleRecalcCount ?? 0;
        }
      } catch {
        // ignore
      }
    }, []);

    const bumpRecalcCounters = useCallback(() => {
      try {
        if (typeof window === 'undefined') return;
        // biome-ignore lint/style/useNamingConvention: Playwright flag
        const isPw = !!(window as unknown as { __PW_TEST__?: boolean }).__PW_TEST__;
        if (!isPw) return;
        const w = window as unknown as {
          feTest?: { bumpVisibleRecalc?: () => void };
        };
        w.feTest?.bumpVisibleRecalc?.();
      } catch {
        // ignore
      }
    }, []);

    const store = useFileExplorerStoreContext();
    const {
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      addSelectedFile,
      removeSelectedFile,
    } = store(
      (s) => ({
        expandedDirectoryPaths: s.expandedDirectoryPaths,
        toggleDirectoryExpansion: s.toggleDirectoryExpansion,
        addSelectedFile: s.addSelectedFile,
        removeSelectedFile: s.removeSelectedFile,
      }),
      shallow
    );

    // Immediate file selection for better responsiveness
    const handleToggleFileSelection = useCallback(
      (path: string) => {
        const encodedPath = encodeFileSelection(folderId, path);
        const isSelected = store.getState().selectedFilePaths.has(encodedPath);
        if (isSelected) {
          removeSelectedFile(folderId, path);
        } else {
          addSelectedFile(folderId, path);
        }
      },
      [folderId, addSelectedFile, removeSelectedFile, store]
    );

    // Phase B: Maintain a stable visibleRows cache that only mutates on expand/collapse or data arrival
    type VisibleRow = { path: string; depth: number; isDir: boolean; expanded: boolean };
    const visibleRowsRef = useRef<VisibleRow[]>([]);
    const [, setRowsVersion] = useState(0);
    // Initialize virtualizer early so callbacks can rely on the ref
    const visibleCount = visibleRowsRef.current.length;
    const { containerRef, range, totalHeight } = useVirtualList(visibleCount, ROW_HEIGHT, {
      overscan: 16,
    });
    const nudgeVirtualizer = useCallback(() => {
      try {
        if (typeof window !== 'undefined') {
          const el = containerRef.current as HTMLElement | null;
          if (el) requestAnimationFrame(() => el.dispatchEvent(new Event('scroll')));
        }
      } catch {
        // ignore
      }
    }, [containerRef]);

    // Path -> node map to resolve nodes for rendered rows
    const pathToNodeMapRef = useRef<Map<string, IFileNode>>(new Map());

    const buildPathMap = useCallback((nodes: IFileNode[]) => {
      const map = new Map<string, IFileNode>();
      const walk = (arr: IFileNode[]) => {
        for (const n of arr) {
          map.set(n.path, n);
          if (n.type === 'directory' && n.children && n.children.length > 0) {
            walk(n.children);
          }
        }
      };
      walk(nodes);
      pathToNodeMapRef.current = map;
    }, []);

    const findNodeByPath = useCallback(
      (path: string): IFileNode | undefined => pathToNodeMapRef.current.get(path),
      []
    );

    const buildSubtreeRows = useCallback(
      (node: IFileNode, depth: number, expandedSet: Set<string>): VisibleRow[] => {
        const out: VisibleRow[] = [];
        if (node.type !== 'directory' || !node.children) return out;
        const children = node.children.filter((c) => c.isVisible !== false);
        for (const c of children) {
          const isDir = c.type === 'directory';
          const isExpanded = isDir && expandedSet.has(c.path);
          out.push({ path: c.path, depth: depth + 1, isDir, expanded: isExpanded });
          if (isDir && isExpanded && c.children && c.children.length > 0) {
            out.push(...buildSubtreeRows(c, depth + 1, expandedSet));
          }
        }
        return out;
      },
      []
    );

    // Helper to setup test window object
    const setupTestWindow = useCallback((visibleRows: VisibleRow[]) => {
      if (typeof window === 'undefined') return;
      // Only set up test helpers if running in Playwright tests
      // biome-ignore lint/style/useNamingConvention: Playwright test flag follows their convention
      if (!(window as unknown as { __PW_TEST__?: boolean }).__PW_TEST__) return;

      try {
        const names = visibleRows
          .map((row) => pathToNodeMapRef.current.get(row.path)?.name)
          .filter(Boolean) as string[];
        interface TestWindow {
          feTest?: {
            waitForName?: (name: string, timeout?: number) => Promise<boolean>;
            visibleNames?: string[];
            visiblePaths?: string[];
          };
        }
        const w = window as unknown as TestWindow;
        if (!w.feTest) w.feTest = {};
        w.feTest.visiblePaths = visibleRows.map((r) => r.path);
        w.feTest.visibleNames = names;
        if (!w.feTest.waitForName) {
          w.feTest.waitForName = (name: string, timeout = 15000) =>
            new Promise<boolean>((resolve) => {
              const start = performance.now();
              const tick = () => {
                const list = w.feTest?.visibleNames || [];
                if (list.includes(name)) return resolve(true);
                if (performance.now() - start > timeout) return resolve(false);
                requestAnimationFrame(tick);
              };
              tick();
            });
        }
      } catch {}
    }, []);

    const rebuildVisibleFromTree = useCallback(
      (nodes: IFileNode[], expandedSet: Set<string>) => {
        const next: VisibleRow[] = [];
        const roots = nodes.filter((n) => n.isVisible !== false);
        for (const r of roots) {
          const isDir = r.type === 'directory';
          const isExpanded = isDir && expandedSet.has(r.path);
          next.push({ path: r.path, depth: 0, isDir, expanded: isExpanded });
          if (isDir && isExpanded) {
            next.push(...buildSubtreeRows(r, 0, expandedSet));
          }
        }
        visibleRowsRef.current = next;
        setRowsVersion((v) => v + 1);
        setupTestWindow(next);
        publishVisibleRows(next);
        // Count a rebuild on initial build and on filter commits (source tree changes)
        bumpRecalcCounters();
        // Nudge virtualizer after commit using ref
        nudgeVirtualizer();
      },
      [buildSubtreeRows, setupTestWindow, publishVisibleRows, bumpRecalcCounters, nudgeVirtualizer]
    );

    const getRowIndex = useCallback((path: string): number => {
      const arr = visibleRowsRef.current;
      for (let i = 0; i < arr.length; i++) if (arr[i]?.path === path) return i;
      return -1;
    }, []);

    const findSubtreeRange = useCallback(
      (idx: number): { start: number; end: number; parentDepth: number } | null => {
        const parent = visibleRowsRef.current[idx];
        if (!parent) return null;
        const start = idx + 1;
        let end = start;
        const parentDepth = parent.depth;
        const arr = visibleRowsRef.current;
        while (end < arr.length) {
          const row = arr[end];
          if (!row || row.depth <= parentDepth) break;
          end++;
        }
        return { start, end, parentDepth };
      },
      []
    );

    // rangesDiffer retained for later incremental subtree updates in D-phase

    const dirtyRef = useRef(false);
    const flushIfDirty = useCallback(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setRowsVersion((v) => v + 1);
      publishVisibleRows(visibleRowsRef.current);
      // Count a rebuild for expand/collapse splice batches
      bumpRecalcCounters();
      // ensure range recalculates even if length didn't change — next animation frame after commit
      nudgeVirtualizer();
    }, [publishVisibleRows, bumpRecalcCounters, nudgeVirtualizer]);

    const spliceExpand = useCallback(
      (index: number) => {
        const parent = visibleRowsRef.current[index];
        if (!parent) return;
        const parentNode = findNodeByPath(parent.path);
        if (!parentNode || parentNode.type !== 'directory') return;
        const childrenRows = buildSubtreeRows(parentNode, parent.depth, expandedDirectoryPaths);
        if (childrenRows.length === 0) return;
        visibleRowsRef.current.splice(index + 1, 0, ...childrenRows);
        dirtyRef.current = true;
      },
      [buildSubtreeRows, expandedDirectoryPaths, findNodeByPath]
    );

    const spliceCollapse = useCallback(
      (index: number) => {
        const range = findSubtreeRange(index);
        if (!range) return;
        const { start, end } = range;
        if (end > start) {
          visibleRowsRef.current.splice(start, end - start);
          dirtyRef.current = true;
        }
      },
      [findSubtreeRange]
    );

    // Helper retained for future phases (D-phase subtree math). Not used in B-phase full rebuild path.

    const applyCollapses = useCallback(
      (prev: Set<string>, next: Set<string>) => {
        for (const p of prev) {
          if (!next.has(p)) {
            const idx = getRowIndex(p);
            if (idx !== -1) spliceCollapse(idx);
          }
        }
      },
      [getRowIndex, spliceCollapse]
    );

    const applyExpands = useCallback(
      (prev: Set<string>, next: Set<string>) => {
        for (const p of next) {
          if (!prev.has(p)) {
            const idx = getRowIndex(p);
            if (idx !== -1) spliceExpand(idx);
          }
        }
      },
      [getRowIndex, spliceExpand]
    );

    // Note: syncing expanded subtrees on fileTree change is handled by full rebuild above

    // Track expanded set deltas and mutate the visible list accordingly
    const prevExpandedRef = useRef<Set<string>>(new Set());
    useLayoutEffect(() => {
      const prev = prevExpandedRef.current;
      const next = expandedDirectoryPaths;
      applyCollapses(prev, next);
      applyExpands(prev, next);
      prevExpandedRef.current = new Set(next);
      // Flush immediately for instant UI feedback
      flushIfDirty();
      // We purposely exclude splice helpers from deps because they are stable via useCallback
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expandedDirectoryPaths, applyCollapses, applyExpands, flushIfDirty]);

    // Rebuild path map and visible list only when the source fileTree changes
    useLayoutEffect(() => {
      buildPathMap(fileTree);
      rebuildVisibleFromTree(fileTree, prevExpandedRef.current);
    }, [fileTree, buildPathMap, rebuildVisibleFromTree]);

    // (virtualizer initialized earlier)

    // Optional external nudge support: keep listener for tests/host integrations
    useLayoutEffect(() => {
      const onNudge = () => {
        flushIfDirty(); // will call nudgeVirtualizer internally
      };
      window.addEventListener(evtNudge, onNudge);
      return () => window.removeEventListener(evtNudge, onNudge);
    }, [flushIfDirty, evtNudge]);

    // Removed rAF auto-nudge; same-tick flush directly nudges scroll

    // Expose an explicit ready event when visible list updates and first frame paints
    /* biome-ignore lint/correctness/useExhaustiveDependencies: containerRef.current intentionally read inside rAF */
    useLayoutEffect(() => {
      const readyToken = visibleCount;
      const id = requestAnimationFrame(() => {
        const el = containerRef.current as HTMLElement | null;
        if (el) el.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new CustomEvent('file-tree-ready', { detail: readyToken }));
      });
      return () => cancelAnimationFrame(id);
    }, [visibleCount]);

    // Optimized row rendering with better memoization
    const renderedRows = useMemo(() => {
      const startIndex = range.start;
      const endIndex = range.end;
      const rows: ReactNode[] = [];
      const all = visibleRowsRef.current;

      for (let i = startIndex; i <= endIndex; i++) {
        const item = all[i];
        if (!item) continue;
        const node = findNodeByPath(item.path);
        if (!node) continue;
        const rowIndex = i - startIndex;
        rows.push(
          <OptimizedFileTreeRow
            key={node.path}
            node={node}
            depth={item.depth}
            isExpanded={expandedDirectoryPaths.has(node.path)}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
            folderId={folderId}
            style={{
              position: 'absolute',
              top: (startIndex + rowIndex) * ROW_HEIGHT,
              width: '100%',
              height: ROW_HEIGHT,
            }}
          />
        );
      }

      return rows;
    }, [
      range.start,
      range.end,
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
      findNodeByPath,
    ]);

    // This effect will run if the onRender callback itself changes.
    useEffect(() => {
      onRender?.();
    }, [onRender]);

    // No cleanup needed anymore

    return (
      <div
        ref={containerRef}
        className="h-full relative flex-1 min-h-0 overflow-y-auto"
        data-testid="file-tree-scroll-container"
      >
        <div
          className="relative file-tree"
          role="tree"
          aria-label="File tree"
          data-testid="file-tree"
        >
          <fieldset
            className="border-0 m-0 p-0"
            style={{ position: 'relative', height: totalHeight }}
          >
            {renderedRows}
          </fieldset>
        </div>
      </div>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

// Enhanced memoization comparison
const OptimizedFileTreeMemoized = memo(OptimizedFileTree, (prevProps, nextProps) => {
  // Re-render when file tree identity changes (captures deep structural updates reliably)
  if (prevProps.fileTree !== nextProps.fileTree) return false;

  // Re-render if folder context or callbacks change
  if (prevProps.folderId !== nextProps.folderId) return false;
  if (prevProps.onRender !== nextProps.onRender) return false;

  // Re-render when loading set meaningfully changes
  if (prevProps.loadingFiles === nextProps.loadingFiles) return true;
  if (prevProps.loadingFiles.size !== nextProps.loadingFiles.size) return false;
  for (const p of prevProps.loadingFiles) if (!nextProps.loadingFiles.has(p)) return false;

  return true;
});

export default OptimizedFileTreeMemoized;
