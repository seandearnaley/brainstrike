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
            This will permanently delete all imported files ({recordsCount}) and chunks (
            {chunksCount}) from the database. This action cannot be undone.
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
