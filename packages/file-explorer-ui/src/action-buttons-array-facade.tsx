import * as React from 'react';
import { ActionButtons } from './action-buttons';

interface Props {
  displayedFiles: readonly string[];
  selectedFiles: readonly string[];
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (next: readonly string[]) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded: () => void | Promise<void>;
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
      currentFolderId={props.currentFolderId}
      displayedFiles={displayedSet}
      encodeFileSelection={props.encodeFileSelection}
      maxSelectionCount={props.maxSelectionCount}
      onSelectionLimitExceeded={props.onSelectionLimitExceeded}
      selectedFilePaths={selectedSet}
      setSelectedFiles={setSelectedSet}
    />
  );
};

export default ActionButtonsArrayFacade;
