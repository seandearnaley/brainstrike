/**
 * The Explorer tree grid's NAME cell — checkbox, icon, and file name.
 *
 * Extracted from `optimized-file-tree.tsx` (BST-1208) so the tree column and
 * the metadata columns are siblings rather than one growing file. Behaviour is
 * unchanged from the pre-grid version.
 */

import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useEventCallback } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { LightweightCheckbox } from '@brainstrike/ui';
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Info as InfoIcon,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
} from 'lucide-react';
import { type MouseEvent, memo, useCallback, useSyncExternalStore } from 'react';
import { useFileTreeSelection } from './file-tree-selection-context';
import type { FileTreeRowData } from './optimized-file-tree-model';

interface TreeNodeIconProps {
  isExpanded: boolean;
  isLoading: boolean;
  nodeName: string;
  nodeType: IFileNode['type'];
}

function TreeNodeIcon({ isLoading, nodeType, nodeName, isExpanded }: TreeNodeIconProps) {
  if (isLoading) {
    return (
      <Loader2 aria-label={`Loading ${nodeName}`} className="animate-spin text-info" size={16} />
    );
  }
  if (nodeType === 'truncated') {
    return <InfoIcon className="text-muted-foreground" size={16} />;
  }
  if (nodeType === 'file' || nodeType === 'loadMore') {
    return <FileIcon className="text-muted-foreground" size={16} />;
  }
  if (nodeType === 'directory') {
    if (isExpanded) {
      return <FolderOpen className="text-blue-800 dark:text-blue-300" size={16} />;
    }
    return <Folder className="text-blue-800 dark:text-blue-300" size={16} />;
  }
  return null;
}

/**
 * Cell content for one tree row (file or directory).
 *
 * Reads the STABLE FileTreeSelectionContext (identity fixed across selection
 * toggles) and subscribes to its OWN derived tri-state through the per-node
 * selection store via useSyncExternalStore (#1594b). Because the store returns
 * a stable object while a node's state is unchanged, a selection toggle
 * re-renders only the cells whose own state actually changed (the toggled file
 * plus its ancestor directories), not every visible cell. TreeTableRow's
 * React.memo (columns + row data stay stable) keeps parent re-renders from
 * reaching this cell, so the store subscription is the only re-render trigger.
 */
export interface FileTreeNameCellProps {
  isExpanded: boolean;
  onSelectionChange: (rowData: FileTreeRowData) => void;
  rowData: FileTreeRowData;
}

export const FileTreeNameCell = memo(function FileTreeNameCellComponent({
  rowData,
  isExpanded,
  onSelectionChange,
}: FileTreeNameCellProps) {
  const fileNode = rowData.fileNode;
  const {
    folderId,
    hideSelection,
    isDirectorySelectionLocked,
    maxSelectionCount,
    openFileInTab,
    store,
  } = useFileTreeSelection();
  // Per-node selection state via useSyncExternalStore: this cell re-renders on
  // a selection change ONLY when ITS OWN derived state changed, not on every
  // toggle (#1594). getSnapshot returns a cached object with stable identity
  // while unchanged — the store guarantees that contract.
  const selectionState = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.getNodeState(rowData), [store, rowData])
  );

  /**
   * VS Code-style open semantics. The mouse and keyboard paths are intentionally
   * routed through different DOM nodes for different reasons — both end up calling
   * `openFileInTab` with the same compositeKey:
   *
   * - Mouse: this `handleFileNameClick` fires on the file-name span. We
   *   `stopPropagation()` so the click does NOT bubble to the parent TreeTable row,
   *   which would otherwise also fire `onSelect` and trigger a duplicate open.
   * - Keyboard: TreeTable's row owns focus. Enter/Space on a focused file row fires
   *   TreeTable's `onSelect`, which the parent `OptimizedFileTree` wires to
   *   `handleTreeRowSelect` → `openFileInTab`.
   *
   * Selection (the per-row checkbox) is the multi-select affordance for context
   * export and is independent of both paths.
   *
   * a11y: we deliberately do NOT mark this label `role="button"` because the parent
   * TreeTable row already owns treegrid row semantics; nesting interactive roles
   * announces awkwardly on some screen-reader + browser combos.
   */
  const handleFileNameClick = useEventCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // folderId guard: the FileTreeSelectionContext provider falls back to '' when
    // upstream folderId is undefined. An empty folderId would produce a malformed
    // compositeKey like '|@|src/index.ts'; skip the open instead.
    if (fileNode.type !== 'file' || !openFileInTab || !folderId) {
      return;
    }
    openFileInTab(encodeFileSelection(folderId, fileNode.path));
  });

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {hideSelection ? (
        // Navigation-only pane trees: checkbox-sized spacer keeps row
        // geometry identical to the Files tree without a selection affordance.
        <div aria-hidden="true" className="w-4 flex-shrink-0" />
      ) : (
        <div
          className="flex w-4 flex-shrink-0 items-center justify-center"
          title={
            rowData.isLoadingForSelection
              ? 'Loading folder contents...'
              : fileNode.type === 'file' && selectionState.wouldExceedLimit
                ? `Cannot select more than ${maxSelectionCount} files`
                : undefined
          }
        >
          {rowData.isLoadingForSelection ? (
            <Loader2
              aria-label={`Loading ${fileNode.name} for selection`}
              className="h-4 w-4 animate-spin text-info"
            />
          ) : (
            // No DOM id: the same path renders in multiple tree surfaces
            // (panel + preview/dialog) and across roots, so a path-derived id
            // produces duplicate-id documents; aria-label carries the name.
            //
            // Disable rules (decision D3): the cap disables only FILE adds (a
            // single-file add at the cap is a true no-op). Directory checkboxes
            // never disable for the cap — deselect must always work and adds
            // partial-fill with a toast. During a recursive scan EVERY checkbox
            // disables (clicks are ignored; the affordance must not lie).
            <LightweightCheckbox
              aria-label={`Select ${fileNode.name}`}
              checked={selectionState.checkboxState}
              className="h-4 w-4"
              disabled={
                isDirectorySelectionLocked ||
                (fileNode.type === 'file' && selectionState.wouldExceedLimit) ||
                fileNode.type === 'loadMore' ||
                fileNode.type === 'truncated'
              }
              onCheckedChange={() => onSelectionChange(rowData)}
            />
          )}
        </div>
      )}

      <div className="flex w-4 flex-shrink-0 items-center justify-center">
        <TreeNodeIcon
          isExpanded={isExpanded}
          isLoading={rowData.isFileLoading}
          nodeName={fileNode.name}
          nodeType={fileNode.type}
        />
      </div>

      {/* The parent TreeTable row owns treegrid semantics; avoid adding a nested button role here. */}
      <div
        {...(fileNode.type === 'file' && openFileInTab
          ? {
              // cursor-pointer + hover underline only when the click actually does
              // something: if openFileInTab isn't registered (no IdeFileEditor host
              // wired up), the visual affordance would lie about the row's behavior.
              className: 'group/file-row flex min-w-0 flex-1 cursor-pointer items-center',
              onClick: handleFileNameClick,
            }
          : { className: 'flex min-w-0 flex-1 items-center' })}
      >
        {fileNode.isSymbolicLink && (
          <Link2Icon className="mr-1.5 h-4 w-4 flex-shrink-0 text-blue-800 dark:text-blue-300" />
        )}
        <span
          className={
            fileNode.type === 'truncated'
              ? 'truncate text-muted-foreground text-sm italic leading-4'
              : 'truncate text-sm leading-4 group-hover/file-row:underline'
          }
        >
          {fileNode.name}
        </span>
        {fileNode.type === 'directory' && fileNode.isDepthTruncated && (
          <MoreHorizontalIcon className="ml-1.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
      </div>
    </div>
  );
});
