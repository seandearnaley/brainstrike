import { Button, Label } from '@brainstrike/ui';

export interface ClearStoredFoldersPanelProps {
  hasStoredFolders: boolean;
  onClearFolders: () => void;
  isWebPlatform?: boolean;
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
    <div className="space-y-1 rounded-md border bg-muted/20 p-3">
      <Label className="text-xs">Stored Folders</Label>
      <p className="text-[11px] text-muted-foreground">
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
