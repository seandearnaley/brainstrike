import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Badge, Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';
import FileExplorerConfig from './file-explorer-config';
import { FileFilterBar } from './file-filter-bar';

interface FileExplorerToolbarProps {
  onDirectorySelect: () => Promise<void>;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  filterError: string | null;
  quickFilter: string;
  setQuickFilter: (value: string) => void;
  clearQuickFilter: () => void;
  isLoading: boolean;
  rootDirectoryHandle: DirectoryHandle | null;
  selectedCount: number;
  maxSelectionCount: number;
}

const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = React.memo(
  ({
    onDirectorySelect,
    onFilterChange,
    filterError,
    quickFilter,
    setQuickFilter,
    clearQuickFilter,
    isLoading,
    rootDirectoryHandle,
    selectedCount,
    maxSelectionCount,
  }) => {
    return (
      <div className="flex flex-col gap-2 px-2 py-2 border-b">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="select-root-button"
              onClick={onDirectorySelect}
              disabled={isLoading}
            >
              <Folder className="h-4 w-4 mr-2" />
              {FileExplorerStrings.selectRoot}
            </Button>
            <FileExplorerConfig filterError={filterError} onFilterChange={onFilterChange} />
          </div>
          <output>
            <Badge
              variant={selectedCount === maxSelectionCount ? 'destructive' : 'secondary'}
              className="whitespace-nowrap text-xs sm:text-sm"
            >
              <span data-testid="selection-count">{selectedCount}</span>/
              <span data-testid="selection-max">{maxSelectionCount}</span>
            </Badge>
          </output>
        </div>
        {rootDirectoryHandle && (
          <FileFilterBar value={quickFilter} onChange={setQuickFilter} onClear={clearQuickFilter} />
        )}
      </div>
    );
  }
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
