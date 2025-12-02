import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Badge, Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';
import { FileFilterBar } from './file-filter-bar';
import WorkspaceSettings from './workspace-settings';

type FileExplorerToolbarProps = {
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
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
  };
};

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
    inlineFixtureSetting,
  }) => (
    <div className="flex flex-col gap-2 border-b px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            data-testid="select-root-button"
            disabled={isLoading}
            onClick={onDirectorySelect}
            size="sm"
            variant="outline"
          >
            <Folder className="mr-2 h-4 w-4" />
            {FileExplorerStrings.selectRoot}
          </Button>
          <WorkspaceSettings
            filterError={filterError}
            onFilterChange={onFilterChange}
            {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
          />
        </div>
        <output>
          <Badge
            className="whitespace-nowrap text-xs sm:text-sm"
            variant={selectedCount === maxSelectionCount ? 'destructive' : 'secondary'}
          >
            <span data-testid="selection-count">{selectedCount}</span>/
            <span data-testid="selection-max">{maxSelectionCount}</span>
          </Badge>
        </output>
      </div>
      {rootDirectoryHandle && (
        <FileFilterBar onChange={setQuickFilter} onClear={clearQuickFilter} value={quickFilter} />
      )}
    </div>
  )
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
