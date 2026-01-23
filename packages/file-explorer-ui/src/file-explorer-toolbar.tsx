import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';
import WorkspaceSettings from './workspace-settings';

interface FileExplorerToolbarProps {
  onDirectorySelect: () => Promise<void>;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  filterError: string | null;
  isLoading: boolean;
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
  };
  hasStoredFolders?: boolean;
  onForgetStoredFolders?: () => void;
}

/**
 * Minimal toolbar with only folder selection and settings buttons.
 * Filter controls (preset selector, quick filter, filter pills) are now in the footer.
 */
const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = React.memo(
  ({
    onDirectorySelect,
    onFilterChange,
    filterError,
    isLoading,
    inlineFixtureSetting,
    hasStoredFolders,
    onForgetStoredFolders,
  }) => (
    <div className="@container flex items-center gap-2 border-b px-2 py-2">
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
        {...(typeof onForgetStoredFolders === 'function'
          ? { onForgetStoredFolders, hasStoredFolders }
          : {})}
        {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
      />
    </div>
  )
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
