'use memo';

import * as React from 'react';
import { ActionButtons as InnerActionButtons } from './action-buttons';

const ActionButtonsInner: React.ComponentType<Record<string, unknown>> =
  InnerActionButtons as unknown as React.ComponentType<Record<string, unknown>>;

type Props = {
  displayedFiles: readonly string[];
  selectedFiles: readonly string[];
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (next: readonly string[]) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded: () => void | Promise<void>;
  onDownloadReport: () => void | Promise<void>;
  onCopyReport: () => void | Promise<void>;
};

const ActionButtonsArrayFacade: React.FC<Props> = (props) => {
  const displayedSet = React.useMemo(() => new Set(props.displayedFiles), [props.displayedFiles]);
  const selectedSet = React.useMemo(() => new Set(props.selectedFiles), [props.selectedFiles]);

  const setSelectedSet = React.useCallback(
    (nextSet: Set<string>) => {
      props.setSelectedFiles(Array.from(nextSet));
    },
    [props.setSelectedFiles]
  );

  return (
    <ActionButtonsInner
      displayedFiles={displayedSet}
      selectedFilePaths={selectedSet}
      maxSelectionCount={props.maxSelectionCount}
      currentFolderId={props.currentFolderId}
      setSelectedFiles={setSelectedSet}
      encodeFileSelection={props.encodeFileSelection}
      onSelectionLimitExceeded={props.onSelectionLimitExceeded}
      onDownloadReport={props.onDownloadReport}
      onCopyReport={props.onCopyReport}
    />
  );
};

export default ActionButtonsArrayFacade;
