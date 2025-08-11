import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useEffect, useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useLazyTree } from './lazy-tree-provider';
import type { LazyTreeApi } from './lazy-tree-types';
import OptimizedFileTreeRow, { ROW_HEIGHT } from './optimized-file-tree-row';
import { useVirtualList } from './use-virtual-list';

// V2 placeholder flat list renderer that accepts precomputed rows.
// For now, it adapts from the legacy tree when rows are not provided.

export interface VisibleRowLike {
  path: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
}

interface OptimizedFlatTreeProps {
  rows?: VisibleRowLike[];
  // temporary adapter path until lazy store provides rows
  fileTree?: IFileNode[];
  loadingFiles: Set<string>;
  folderId: string;
  onRender?: (() => void) | undefined;
}

function flattenLegacy(
  nodes: IFileNode[],
  expandedSet: ReadonlySet<string>,
  depth = 0,
  acc: VisibleRowLike[] = []
): VisibleRowLike[] {
  for (const n of nodes) {
    acc.push({
      path: n.path,
      depth,
      isDir: n.type === 'directory',
      expanded: n.type === 'directory' && expandedSet.has(n.path),
    });
    if (n.type === 'directory' && expandedSet.has(n.path) && n.children) {
      flattenLegacy(
        n.children.filter((c) => c.isVisible !== false),
        expandedSet,
        depth + 1,
        acc
      );
    }
  }
  return acc;
}

const OptimizedFlatTree = memo<OptimizedFlatTreeProps>(
  ({ rows, fileTree, loadingFiles, folderId, onRender }) => {
    const store = useFileExplorerStoreContext();
    // If provided by LazyTreeProvider, prefer computed rows
    let lazyRows: VisibleRowLike[] | null = null;
    // Hooks must be unconditional; use try/catch around mapping only
    const lazyContext = useLazyTree() as LazyTreeApi | null;
    if (lazyContext && Array.isArray(lazyContext.rows)) {
      lazyRows = lazyContext.rows.map((r) => ({
        path: r.path,
        depth: r.depth,
        isDir: r.kind === 'directory',
        expanded: !!r.expanded,
      }));
    }
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

    // Temporary: if rows not provided yet, adapt from legacy tree
    const effectiveRows = useMemo(() => {
      if (lazyRows && lazyRows.length > 0) return lazyRows;
      if (rows && rows.length > 0) return rows;
      if (fileTree && fileTree.length > 0) {
        return flattenLegacy(fileTree, expandedDirectoryPaths);
      }
      return [] as VisibleRowLike[];
    }, [lazyRows, rows, fileTree, expandedDirectoryPaths]);

    const { containerRef, range, offset, totalHeight } = useVirtualList(
      effectiveRows.length,
      ROW_HEIGHT,
      { overscan: 2 }
    );

    // Bridge legacy expandedDirectoryPaths -> lazy store expand/collapse
    useEffect(() => {
      const apiExpand = lazyContext?.expand;
      const apiCollapse = lazyContext?.collapse;
      if (!apiExpand || !apiCollapse) return;

      const current = lazyContext.expanded ?? new Set<string>();
      const next = expandedDirectoryPaths;

      const [toExpand, toCollapse] = (() => {
        const add: string[] = [];
        for (const p of next) if (!current.has(p)) add.push(p);
        const del: string[] = [];
        for (const p of current) if (!next.has(p)) del.push(p);
        return [add, del];
      })();

      if (toExpand.length) apiExpand(toExpand);
      if (toCollapse.length) apiCollapse(toCollapse);
    }, [lazyContext, expandedDirectoryPaths]);

    const renderedRows = useMemo(() => {
      const slice = effectiveRows.slice(range.start, range.end + 1);
      return slice.map((r, index) => {
        const isExpanded = r.expanded;
        // Create minimal node-like structure for row rendering without requiring optional fields
        const base = {
          name: r.path.split('/').pop() || r.path,
          path: r.path,
          depth: r.depth,
        } as const;
        const node = r.isDir
          ? ({ ...base, type: 'directory' } as IFileNode)
          : ({ ...base, type: 'file' } as IFileNode);
        const top = (range.start + index) * ROW_HEIGHT - offset;
        const encoded = encodeFileSelection(folderId, node.path);
        const isLoading = loadingFiles.has(encoded);
        return (
          <OptimizedFileTreeRow
            key={node.path}
            node={node}
            depth={r.depth}
            isExpanded={isExpanded}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={(p) => {
              const selected = store
                .getState()
                .selectedFilePaths.has(encodeFileSelection(folderId, p));
              selected ? removeSelectedFile(folderId, p) : addSelectedFile(folderId, p);
            }}
            isLoading={isLoading}
            folderId={folderId}
            style={{ position: 'absolute', top }}
          />
        );
      });
    }, [
      effectiveRows,
      range,
      offset,
      loadingFiles,
      folderId,
      toggleDirectoryExpansion,
      addSelectedFile,
      removeSelectedFile,
      store,
    ]);

    // Optional onRender for tests
    if (onRender) onRender();

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
            style={{
              position: 'relative',
              height: totalHeight,
              transform: `translateY(${offset}px)`,
            }}
          >
            {renderedRows}
          </fieldset>
        </div>
      </div>
    );
  }
);

OptimizedFlatTree.displayName = 'OptimizedFlatTree';
export default OptimizedFlatTree;
