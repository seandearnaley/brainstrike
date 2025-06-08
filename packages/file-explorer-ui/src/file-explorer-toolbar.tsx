import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import FileExplorerConfig from './file-explorer-config';
import { FileFilterBar } from './file-filter-bar';
import { SelectionCounter } from './selection-counter';

interface FileExplorerToolbarProps {
  onDirectorySelect: () => Promise<void>;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  filterError: string | null;
  quickFilter: string;
  setQuickFilter: (value: string) => void;
  clearQuickFilter: () => void;
  isLoading: boolean;
  rootDirectoryHandle: DirectoryHandle | null;
}

const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = ({
  onDirectorySelect,
  onFilterChange,
  filterError,
  quickFilter,
  setQuickFilter,
  clearQuickFilter,
  isLoading,
  rootDirectoryHandle,
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
        <SelectionCounter />
      </div>
      {rootDirectoryHandle && (
        <FileFilterBar value={quickFilter} onChange={setQuickFilter} onClear={clearQuickFilter} />
      )}
    </div>
  );
};

export { FileExplorerToolbar };
