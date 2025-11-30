import { Badge } from '@brainstrike/ui';
import type * as React from 'react';
import { memo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
// Keep SelectionCounter lightweight to avoid hook-order issues in toolbars

export const SelectionCounter: React.FC = memo(() => {
  const store = useFileExplorerStoreContext();
  // Subscribe to both pieces of state separately to ensure updates
  const selectedCount = store((s) => s.selectedFilePaths.size);
  const maxSelectionCount = store((s) => s.maxSelectionCount);

  return (
    <output>
      <Badge
        className="whitespace-nowrap text-xs sm:text-sm"
        variant={selectedCount === maxSelectionCount ? 'destructive' : 'secondary'}
      >
        <span data-testid="selection-count">{selectedCount}</span>/
        <span data-testid="selection-max">{maxSelectionCount}</span>
      </Badge>
    </output>
  );
});

SelectionCounter.displayName = 'SelectionCounter';
