import { Badge } from '@brainstrike/ui';
import * as React from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';

export const SelectionCounter: React.FC = React.memo(() => {
  const store = useFileExplorerStoreContext();
  const { selectedFilePaths, maxSelectionCount } = store(
    (s) => ({
      selectedFilePaths: s.selectedFilePaths,
      maxSelectionCount: s.maxSelectionCount,
    }),
    shallow
  );
  const selectedCount = selectedFilePaths.size;

  return (
    <output>
      <Badge
        variant={selectedCount === maxSelectionCount ? 'destructive' : 'secondary'}
        className="whitespace-nowrap text-xs sm:text-sm"
      >
        {selectedCount}/{maxSelectionCount}
      </Badge>
    </output>
  );
});

SelectionCounter.displayName = 'SelectionCounter';
