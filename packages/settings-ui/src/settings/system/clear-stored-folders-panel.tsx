import { Button } from '@brainstrike/ui';

export interface ClearStoredFoldersPanelProps {
  hasStoredFolders: boolean;
  isWebPlatform?: boolean;
  onClearFolders: () => void;
}

export function ClearStoredFoldersPanel({
  hasStoredFolders,
  onClearFolders,
  isWebPlatform = true,
}: ClearStoredFoldersPanelProps): React.ReactNode {
  if (!isWebPlatform) {
    return null;
  }

  return (
    <div className="bg-muted/20 space-y-1 rounded-md border p-3">
      <p className="text-xs leading-none font-medium">Stored folders</p>
      <p className="text-muted-foreground text-[11px]">
        Clear all remembered folders for File System access. This will require you to re-select
        folders next time you use the file explorer.
      </p>
      <Button
        className="mt-1 h-6"
        data-testid="clear-stored-folders-button"
        disabled={!hasStoredFolders}
        onClick={onClearFolders}
        size="sm"
        variant="outline"
      >
        Forget all folders
      </Button>
    </div>
  );
}
