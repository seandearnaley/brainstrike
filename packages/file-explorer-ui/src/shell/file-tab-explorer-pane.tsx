import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';
import { useFileTabPaneStore } from '../stores/file-tab-pane-store';
import { FileTreeProvider, useFileTreeContext } from '../tree/file-tree-provider';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { useTabRootHandle } from './use-tab-root-handle';

/**
 * Per-file explorer pane (BST-1269): a navigation-only tree scoped to the
 * tab's workspace root, with PANE-LOCAL expansion state (file-tab-pane-store)
 * so it never fights the Files tree's workspace-global set. Mounts its own
 * FileTreeProvider — the same per-root pattern forest sidebar sections use —
 * so lazy loading and refresh events work identically.
 */
export interface FileTabExplorerPaneProps {
  readonly compositeKey: string;
  /** Re-trigger key: bump to re-reveal the SAME path (repeated clicks). */
  readonly revealNonce: number;
  /** One-shot reveal target forwarded to the tree (file path or folder path). */
  readonly revealPath: string | null;
}

// Shared stable empty set — pane tabs never track per-file content loading.
const EMPTY_LOADING_FILES = new Set<string>();

function PaneTree({
  compositeKey,
  folderId,
  revealNonce,
  revealPath,
}: FileTabExplorerPaneProps & {
  readonly folderId: string;
}): ReactElement {
  const treeContext = useFileTreeContext();
  const expandedPathList = useFileTabPaneStore((state) => state.panes[compositeKey]?.expandedPaths);
  const toggleExpandedPath = useFileTabPaneStore((state) => state.toggleExpandedPath);
  const expandedPaths = useMemo(() => new Set(expandedPathList ?? []), [expandedPathList]);
  const onToggle = useCallback(
    (path: string) => toggleExpandedPath(compositeKey, path),
    [compositeKey, toggleExpandedPath]
  );
  const expansionScope = useMemo(() => ({ expandedPaths, onToggle }), [expandedPaths, onToggle]);

  return (
    <OptimizedFileTree
      ariaLabel="File explorer pane"
      cancelChildLoading={treeContext.cancelChildLoading}
      expansionScope={expansionScope}
      fileTree={treeContext.fileTree}
      folderId={folderId}
      hideSelection={true}
      loadingFiles={EMPTY_LOADING_FILES}
      loadingPaths={treeContext.loadingPaths}
      onLoadChildren={treeContext.loadChildren}
      {...(revealPath === null ? {} : { revealNonce, revealPath })}
    />
  );
}

export function FileTabExplorerPane({
  compositeKey,
  revealNonce,
  revealPath,
}: FileTabExplorerPaneProps): ReactElement {
  const { folderId, handle } = useTabRootHandle(compositeKey);

  if (!(folderId && handle)) {
    // Visible degradation, not a silent fallback: the tab's root is not
    // connected (workspace changed, root disconnected). The file body still
    // renders; only the pane says why it cannot.
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs"
        data-testid="file-tab-pane-unavailable"
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
      <PaneTree
        compositeKey={compositeKey}
        folderId={folderId}
        revealNonce={revealNonce}
        revealPath={revealPath}
      />
    </FileTreeProvider>
  );
}
