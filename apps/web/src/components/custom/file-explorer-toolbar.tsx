import { Button } from '@brainstrike/ui';
import { ChevronsDown, ChevronsUp, Folder, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FileExplorerStrings } from './constants/file-explorer-constants';
import FileExplorerConfig from './file-explorer-config';
import { FileFilterBar } from './file-filter-bar';
import { SelectionCounter } from './selection-counter';

interface FileExplorerToolbarProps {
  onDirectorySelect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  filterError: string | null;
  maxSelectionCount: number;
  quickFilter: string;
  setQuickFilter: (value: string) => void;
  clearQuickFilter: () => void;
  isLoading: boolean;
  isRefreshing: boolean;
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = ({
  onDirectorySelect,
  onRefresh,
  onFilterChange,
  filterError,
  maxSelectionCount,
  quickFilter,
  setQuickFilter,
  clearQuickFilter,
  isLoading,
  isRefreshing,
  rootDirectoryHandle,
  onExpandAll,
  onCollapseAll,
}) => {
  return (
    <div className="flex flex-col gap-2 p-2 border-b">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onDirectorySelect}
            disabled={isLoading && !isRefreshing}
          >
            <Folder className="h-4 w-4 mr-2" />
            {FileExplorerStrings.SELECT_ROOT}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading || isRefreshing}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', { 'animate-spin': isRefreshing })} />
            {FileExplorerStrings.REFRESH}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onExpandAll}
            disabled={isLoading || isRefreshing}
          >
            <ChevronsDown className="h-4 w-4 mr-2" />
            Expand All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCollapseAll}
            disabled={isLoading || isRefreshing}
          >
            <ChevronsUp className="h-4 w-4 mr-2" />
            Collapse All
          </Button>
          <FileExplorerConfig filterError={filterError} onFilterChange={onFilterChange} />
        </div>
        <SelectionCounter maxSelections={maxSelectionCount} />
      </div>
      {rootDirectoryHandle && (
        <FileFilterBar value={quickFilter} onChange={setQuickFilter} onClear={clearQuickFilter} />
      )}
    </div>
  );
};

export { FileExplorerToolbar };
