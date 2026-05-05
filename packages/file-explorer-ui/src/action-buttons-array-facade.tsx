import type { IFileNode } from '@brainstrike/types';
import * as React from 'react';
import { ActionButtons } from './action-buttons';
import type { AddMultipleSelectedFilesChunked } from './hooks/recursive-selection-utils';
import type { SelectAllResult } from './hooks/use-recursive-select-all';

interface Props {
  /** Add multiple selected files (used by recursive selection) */
  addMultipleSelectedFiles?: (folderId: string, paths: string[]) => void;
  /** Add multiple selected files with cooperative chunking for large recursive selections. */
  addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked;
  /** Cancel the current recursive selection operation */
  cancelSelectAll?: () => void;
  currentFolderId: string | null;
  displayedFiles: readonly string[];
  encodeFileSelection: (folderId: string, path: string) => string;
  /**
   * The FILTERED file tree to select from.
   * Pass quickFilteredTree to respect workspace include/exclude filters.
   */
  filteredTree?: IFileNode[];
  hasActiveQuickFilter?: boolean;
  /** Whether the tree has any files (used to enable/disable Select All) */
  hasFilesInTree?: boolean;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll?: boolean;
  maxSelectionCount: number;
  /** Called when bulk selection reaches the configured file selection limit. */
  onSelectionLimitExceeded?: () => void;
  /**
   * Recursively select all files in the provided tree, loading if needed.
   * IMPORTANT: The first parameter is the filtered tree to operate on.
   */
  selectAllRecursively?: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<SelectAllResult>;
  selectedFiles: readonly string[];
  setSelectedFiles: (next: readonly string[]) => void;
  visibleFilePaths?: readonly string[];
}

const ActionButtonsArrayFacade: React.FC<Props> = (props) => {
  const { displayedFiles, selectedFiles, setSelectedFiles } = props;

  // Reuse Set instances to reduce GC pressure for large arrays
  const displayedSet = React.useMemo(() => new Set(displayedFiles), [displayedFiles]);
  const selectedSet = React.useMemo(() => new Set(selectedFiles), [selectedFiles]);

  const setSelectedSet = React.useCallback(
    (nextSet: Set<string>) => {
      setSelectedFiles(Array.from(nextSet));
    },
    [setSelectedFiles]
  );

  return (
    <ActionButtons
      addMultipleSelectedFiles={props.addMultipleSelectedFiles}
      addMultipleSelectedFilesChunked={props.addMultipleSelectedFilesChunked}
      cancelSelectAll={props.cancelSelectAll}
      currentFolderId={props.currentFolderId}
      displayedFiles={displayedSet}
      encodeFileSelection={props.encodeFileSelection}
      filteredTree={props.filteredTree}
      hasActiveQuickFilter={props.hasActiveQuickFilter}
      hasFilesInTree={props.hasFilesInTree}
      isLoadingForSelectAll={props.isLoadingForSelectAll}
      maxSelectionCount={props.maxSelectionCount}
      onSelectionLimitExceeded={props.onSelectionLimitExceeded}
      selectAllRecursively={props.selectAllRecursively}
      selectedFilePaths={selectedSet}
      setSelectedFiles={setSelectedSet}
      visibleFilePaths={props.visibleFilePaths}
    />
  );
};

export default ActionButtonsArrayFacade;
