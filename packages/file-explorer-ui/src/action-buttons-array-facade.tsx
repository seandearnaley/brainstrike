import type { IFileNode } from '@brainstrike/types';
import * as React from 'react';
import { ActionButtons } from './action-buttons';
import type { SelectAllResult } from './hooks/use-recursive-select-all';

interface Props {
  displayedFiles: readonly string[];
  selectedFiles: readonly string[];
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (next: readonly string[]) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded: () => void | Promise<void>;
  /** Whether the tree has any files (used to enable/disable Select All) */
  hasFilesInTree?: boolean;
  /**
   * The FILTERED file tree to select from.
   * Pass quickFilteredTree to respect workspace include/exclude filters.
   */
  filteredTree?: IFileNode[];
  /**
   * Recursively select all files in the provided tree, loading if needed.
   * IMPORTANT: The first parameter is the filtered tree to operate on.
   */
  selectAllRecursively?: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number
  ) => Promise<SelectAllResult>;
  /** Cancel the current recursive selection operation */
  cancelSelectAll?: () => void;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll?: boolean;
  /** Add multiple selected files (used by recursive selection) */
  addMultipleSelectedFiles?: (folderId: string, paths: string[]) => void;
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
      cancelSelectAll={props.cancelSelectAll}
      currentFolderId={props.currentFolderId}
      displayedFiles={displayedSet}
      encodeFileSelection={props.encodeFileSelection}
      filteredTree={props.filteredTree}
      hasFilesInTree={props.hasFilesInTree}
      isLoadingForSelectAll={props.isLoadingForSelectAll}
      maxSelectionCount={props.maxSelectionCount}
      onSelectionLimitExceeded={props.onSelectionLimitExceeded}
      selectAllRecursively={props.selectAllRecursively}
      selectedFilePaths={selectedSet}
      setSelectedFiles={setSelectedSet}
    />
  );
};

export default ActionButtonsArrayFacade;
