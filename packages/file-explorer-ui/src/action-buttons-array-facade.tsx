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
  /** Recursively select all files in the entire tree, loading if needed */
  selectAllRecursively?: (
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

// Reuse Set instances to reduce GC pressure for large arrays
function useStableSet(source: readonly string[]) {
  const ref = React.useRef<{ arr: readonly string[]; set: Set<string> } | null>(null);
  if (!ref.current || ref.current.arr !== source) {
    ref.current = { arr: source, set: new Set(source) };
  }
  return ref.current.set;
}

const ActionButtonsArrayFacade: React.FC<Props> = (props) => {
  const displayedSet = useStableSet(props.displayedFiles);
  const selectedSet = useStableSet(props.selectedFiles);

  const setSelectedSet = React.useCallback(
    (nextSet: Set<string>) => {
      props.setSelectedFiles(Array.from(nextSet));
    },
    [props.setSelectedFiles]
  );

  return (
    <ActionButtons
      addMultipleSelectedFiles={props.addMultipleSelectedFiles}
      cancelSelectAll={props.cancelSelectAll}
      currentFolderId={props.currentFolderId}
      displayedFiles={displayedSet}
      encodeFileSelection={props.encodeFileSelection}
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
