import type { FileChunk, FileRecord } from '@brainstrike/db';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';

type ClearDatabaseDialogProps = {
  records: FileRecord[];
  chunks: FileChunk[];
  clearing: boolean;
  showClearDialog: boolean;
  setShowClearDialog: (show: boolean) => void;
  onClear: () => Promise<void>;
};

/**
 * Dialog-only component for confirming database clear.
 * The trigger button is in SettingsPanel (Import Settings > Danger Zone).
 */
export function ClearDatabaseDialog({
  records,
  chunks,
  clearing,
  showClearDialog,
  setShowClearDialog,
  onClear,
}: ClearDatabaseDialogProps) {
  return (
    <Dialog onOpenChange={setShowClearDialog} open={showClearDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear Database</DialogTitle>
          <DialogDescription>
            This will permanently delete all imported files ({records.length}) and chunks (
            {chunks.length}) from the database. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button disabled={clearing} onClick={() => setShowClearDialog(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={clearing} onClick={onClear} variant="destructive">
            {clearing ? 'Clearing...' : 'Clear Database'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
