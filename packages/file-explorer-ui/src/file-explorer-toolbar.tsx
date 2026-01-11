import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';
import { FileFilterBar } from './file-filter-bar';
import { SelectionCounter } from './selection-counter';
import WorkspaceSettings from './workspace-settings';

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
  onMaxSelectionCountChange?: (count: number) => void;
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
  };
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
    onMaxSelectionCountChange,
    inlineFixtureSetting,
  }) => (
    <div className="@container flex flex-col gap-2 border-b px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            aria-label={FileExplorerStrings.selectRoot}
            className="@[300px]:h-9 h-8 @[300px]:px-3 px-2"
            data-testid="select-root-button"
            disabled={isLoading}
            onClick={onDirectorySelect}
            size="sm"
            variant="outline"
          >
            <Folder className="@[300px]:mr-2 size-4" />
            <span className="@[300px]:inline hidden">{FileExplorerStrings.selectRoot}</span>
          </Button>
          <WorkspaceSettings
            filterError={filterError}
            onFilterChange={onFilterChange}
            {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
          />
        </div>
        <SelectionCounter
          maxSelectionCount={maxSelectionCount}
          onMaxSelectionCountChange={onMaxSelectionCountChange}
          selectedCount={selectedCount}
        />
      </div>
      {rootDirectoryHandle && (
        <FileFilterBar onChange={setQuickFilter} onClear={clearQuickFilter} value={quickFilter} />
      )}
    </div>
  )
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
