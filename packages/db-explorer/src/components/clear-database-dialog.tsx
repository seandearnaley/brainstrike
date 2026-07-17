import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';

interface ClearDatabaseDialogProps {
  chunksCount: number;
  clearing: boolean;
  countsPending?: boolean;
  onClear: () => Promise<void>;
  recordsCount: number;
  setShowClearDialog: (show: boolean) => void;
  showClearDialog: boolean;
}

/**
 * Dialog-only component for confirming database clear.
 * The trigger button is in SettingsPanel (Import Settings > Danger Zone).
 */
export function ClearDatabaseDialog({
  recordsCount,
  chunksCount,
  countsPending = false,
  clearing,
  showClearDialog,
  setShowClearDialog,
  onClear,
}: ClearDatabaseDialogProps) {
  return (
    <Dialog onOpenChange={setShowClearDialog} open={showClearDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear All Collections</DialogTitle>
          <DialogDescription>
            {countsPending
              ? 'Collection counts are still loading. Wait for fresh counts before clearing data.'
              : `This will permanently delete all imported files (${recordsCount}) and chunks (${chunksCount}) from the database. This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button disabled={clearing} onClick={() => setShowClearDialog(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={clearing || countsPending} onClick={onClear} variant="destructive">
            {clearing ? 'Clearing...' : 'Clear All Collections'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
