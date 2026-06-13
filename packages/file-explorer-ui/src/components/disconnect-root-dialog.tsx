import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from '@brainstrike/ui';
import * as React from 'react';

export interface DisconnectRootDialogProps {
  /** Display name of the root being disconnected (e.g. handle.name). */
  displayName: string;
  /**
   * Called when the user confirms. `deleteData: true` means the root's
   * indexed DB rows are deleted too (cascade); false = disconnect only.
   */
  onConfirm: (options: { deleteData: boolean }) => void;
  /** Radix-style open state setter (false on cancel/escape/overlay click). */
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * Confirmation dialog for disconnecting a root from the forest sidebar.
 *
 * Disconnect ≠ delete by default: the body states that indexed data is KEPT
 * and the folder can be re-added later (re-adding resumes without
 * re-indexing). The opt-in checkbox (Phase 6) switches to a true cascade
 * delete — the copy changes accordingly, and the opt-in never survives a
 * close/reopen cycle. Mirrors the repo's destructive-confirm Dialog pattern
 * (see delete-embedding-set-dialog.tsx in vector-management).
 */
export const DisconnectRootDialog: React.FC<DisconnectRootDialogProps> = ({
  displayName,
  onConfirm,
  onOpenChange,
  open,
}) => {
  const [deleteData, setDeleteData] = React.useState(false);

  // A destructive opt-in must never survive a close/reopen cycle.
  React.useEffect(() => {
    if (!open) {
      setDeleteData(false);
    }
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Disconnect {displayName}?</DialogTitle>
          <DialogDescription>
            {deleteData
              ? 'This removes the folder from the sidebar and permanently deletes its indexed data. Re-adding the folder later will re-index it from scratch.'
              : 'This removes the folder from the sidebar. Its indexed data is kept, so you can re-add the same folder later and it will be available again without re-indexing.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center space-x-2">
          <Checkbox
            checked={deleteData}
            id="disconnect-delete-data"
            onCheckedChange={(checked) => setDeleteData(checked === true)}
          />
          <Label className="text-sm" htmlFor="disconnect-delete-data">
            Also delete indexed data
          </Label>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={() => onConfirm({ deleteData })} type="button" variant="destructive">
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

DisconnectRootDialog.displayName = 'DisconnectRootDialog';
