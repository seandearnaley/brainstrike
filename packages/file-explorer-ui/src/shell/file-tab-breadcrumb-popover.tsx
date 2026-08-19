import { Loader2 } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { FileTreeProvider, useFileTreeContext } from '../tree/file-tree-provider';
import { BreadcrumbMiniTree } from './breadcrumb-mini-tree';
import {
  collectMiniTreeLoadChain,
  findMiniTreeNode,
  flattenMiniTreeEntries,
  resolveMiniTreeParentPath,
} from './breadcrumb-mini-tree-entries';
import { useTabRootHandle } from './use-tab-root-handle';

/**
 * Breadcrumb popover content (BST-1319): a mini file tree of the clicked
 * segment's siblings (its parent directory's contents), lazy drill-down,
 * pick-a-file navigation. Mounts its own FileTreeProvider — the popover only
 * exists while open, so the provider (and its directory loads) is strictly
 * on-demand; the ancestor chain down to the parent is materialized via
 * `loadSpecificPaths`, the same lazy path the expansion-restoration flow
 * uses. Expansion state is popover-local and intentionally ephemeral.
 */
export interface FileTabBreadcrumbPopoverProps {
  readonly compositeKey: string;
  /** Absolute/tree-form node path of the picked FILE. */
  readonly onPickFile: (path: string) => void;
  readonly rootPath: string | null;
  /** The clicked segment's cumulative path (original separator form). */
  readonly segmentPath: string;
}

function PopoverTree({
  onPickFile,
  rootPath,
  segmentPath,
}: Omit<FileTabBreadcrumbPopoverProps, 'compositeKey'>): ReactElement {
  const treeContext = useFileTreeContext();
  const parentPath = useMemo(
    () => resolveMiniTreeParentPath(segmentPath, rootPath),
    [rootPath, segmentPath]
  );
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const chain = useMemo(
    () => collectMiniTreeLoadChain(parentPath, rootPath),
    [parentPath, rootPath]
  );
  // The popover content mounts fresh on every open (Radix unmounts closed
  // content) and the segment is fixed for its lifetime, so an empty chain is
  // settled from the start — no effect round-trip.
  const [chainSettled, setChainSettled] = useState(() => chain.length === 0);

  const { loadChildren, loadSpecificPaths } = treeContext;
  useEffect(() => {
    if (chain.length === 0) {
      return;
    }
    let cancelled = false;
    const settleChain = (): void => {
      if (!cancelled) {
        setChainSettled(true);
      }
    };
    void loadSpecificPaths(chain).then(settleChain, settleChain);
    return () => {
      cancelled = true;
    };
  }, [chain, loadSpecificPaths]);

  // loadSpecificPaths can legitimately skip work (adapter-dependent), leaving
  // the parent node PRESENT but its children unloaded. Ensure the parent's
  // children load whenever it sits unloaded — without this the popover would
  // render an empty tree for a non-empty directory.
  const parentNode = useMemo(
    () => (parentPath === null ? null : findMiniTreeNode(treeContext.fileTree, parentPath)),
    [parentPath, treeContext.fileTree]
  );
  useEffect(() => {
    if (parentNode?.type !== 'directory') {
      return;
    }
    const untouched = parentNode.loadState === 'unloaded' || parentNode.loadState === undefined;
    if (untouched && parentNode.children === undefined) {
      void loadChildren(parentNode.path);
    }
  }, [loadChildren, parentNode]);

  const entries = useMemo(
    () => flattenMiniTreeEntries(treeContext.fileTree, parentPath, expandedPaths),
    [expandedPaths, parentPath, treeContext.fileTree]
  );

  const handleToggleDir = useCallback(
    (path: string) => {
      // Side effects stay OUT of the state updater — React may re-invoke
      // updaters (they must be pure), which would double-fire loadChildren.
      const expanding = !expandedPaths.has(path);
      setExpandedPaths((previous) => {
        const next = new Set(previous);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (expanding) {
        const node = findMiniTreeNode(treeContext.fileTree, path);
        if (node && node.loadState !== 'loaded') {
          void loadChildren(path);
        }
      }
    },
    [expandedPaths, loadChildren, treeContext.fileTree]
  );

  // Three terminal render states, resolved in order — never a silent empty
  // tree (or an eternal spinner) for a directory that failed to enumerate:
  //  - unavailable: the ROOT enumeration errored (treeContext.error — the
  //    only failure signal a root-level listing has), the chain settled and
  //    the parent is still absent, or the parent's own load errored
  //    (deleted, renamed, read failure). Drilled-down child failures render
  //    as inline error rows instead (see flattenMiniTreeEntries);
  //  - loading: the parent (or the root level) has not produced children
  //    yet. The tab's own file lives under this root/parent, so a loaded
  //    listing here is never truly empty;
  //  - the tree.
  const rootFailed = treeContext.error !== null && entries.length === 0;
  const parentFailed = parentNode?.loadState === 'error';
  const parentMissing = parentPath !== null && parentNode === null;
  // Root listing that SETTLED empty (no error, load finished): a real state —
  // e.g. every entry file-filtered away — distinct from failure and from
  // loading; without it an empty root would spin forever.
  const rootSettledEmpty =
    parentPath === null &&
    treeContext.error === null &&
    !treeContext.isLoading &&
    entries.length === 0;
  const parentLoaded =
    parentPath === null
      ? entries.length > 0
      : parentNode !== null &&
        (parentNode.loadState === 'loaded' || parentNode.children !== undefined);

  if (rootFailed || parentFailed || (parentMissing && chainSettled)) {
    return (
      <div
        className="p-4 text-center text-muted-foreground text-xs"
        data-testid="breadcrumb-popover-unavailable"
      >
        This folder could not be loaded.
      </div>
    );
  }

  if (rootSettledEmpty) {
    return (
      <div
        className="p-4 text-center text-muted-foreground text-xs"
        data-testid="breadcrumb-popover-empty"
      >
        Nothing to show in this folder.
      </div>
    );
  }

  if (!parentLoaded) {
    return (
      <div
        className="flex items-center justify-center gap-2 p-4 text-muted-foreground text-xs"
        data-testid="breadcrumb-popover-loading"
      >
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        Loading folder…
      </div>
    );
  }

  return (
    <BreadcrumbMiniTree
      entries={entries}
      expandedPaths={expandedPaths}
      loadingPaths={treeContext.loadingPaths}
      onPickFile={onPickFile}
      onToggleDir={handleToggleDir}
      selectedPath={segmentPath}
    />
  );
}

export function FileTabBreadcrumbPopover({
  compositeKey,
  onPickFile,
  rootPath,
  segmentPath,
}: FileTabBreadcrumbPopoverProps): ReactElement {
  const { folderId, handle } = useTabRootHandle(compositeKey);

  if (!(folderId && handle)) {
    // Same explicit degradation as the explorer pane: the tab's root is not
    // connected, and the popover says so instead of rendering an empty tree.
    return (
      <div
        className="p-4 text-center text-muted-foreground text-xs"
        data-testid="breadcrumb-popover-unavailable"
      >
        This file's workspace root is not connected.
      </div>
    );
  }

  return (
    <FileTreeProvider
      disableWorkspaceExpansionRestoration={true}
      key={folderId}
      rootDirectoryHandle={handle}
      rootId={folderId}
    >
      <PopoverTree onPickFile={onPickFile} rootPath={rootPath} segmentPath={segmentPath} />
    </FileTreeProvider>
  );
}
