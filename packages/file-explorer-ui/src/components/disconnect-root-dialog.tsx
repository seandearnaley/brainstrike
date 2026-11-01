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
   * saved record is deleted too; false = disconnect only.
   */
  onConfirm: (options: { deleteData: boolean }) => void;
  /** Radix-style open state setter (false on cancel/escape/overlay click). */
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface DisconnectRootDialogBodyProps {
  displayName: string;
  onConfirm: (options: { deleteData: boolean }) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Body owns the destructive opt-in checkbox. Remounted via `key` whenever the
 * dialog opens/closes so local state never survives a close/reopen cycle
 * (react.dev: reset state with a key, not an Effect syncing props → state).
 */
function DisconnectRootDialogBody({
  displayName,
  onConfirm,
  onOpenChange,
}: DisconnectRootDialogBodyProps): React.ReactElement {
  const [deleteData, setDeleteData] = React.useState(false);

  return (
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Disconnect {displayName}?</DialogTitle>
        <DialogDescription>
          {deleteData
            ? 'This removes the folder from the sidebar and permanently deletes its saved data. Re-adding the folder later adds it as a new folder.'
            : 'This removes the folder from the sidebar. Its saved data is kept, so you can re-add the same folder later and it will be available again.'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center space-x-2">
        <Checkbox
          checked={deleteData}
          id="disconnect-delete-data"
          onCheckedChange={(checked) => setDeleteData(checked === true)}
        />
        <Label className="text-sm" htmlFor="disconnect-delete-data">
          Also delete folder data
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
  );
}

/**
 * Confirmation dialog for disconnecting a root from the forest sidebar.
 *
 * Disconnect ≠ delete by default: the body states that saved data is KEPT
 * and the folder can be re-added later under the same record. The opt-in
 * checkbox (Phase 6) switches to deleting that record — the copy changes accordingly, and the opt-in never survives a
 * close/reopen cycle. Follows the repo's destructive-confirm Dialog pattern.
 */
export const DisconnectRootDialog = ({
  displayName,
  onConfirm,
  onOpenChange,
  open,
}: DisconnectRootDialogProps) => {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/*
        Remount body when `open` flips so the destructive checkbox resets
        without an Effect (https://react.dev/learn/you-might-not-need-an-effect).
      */}
      <DisconnectRootDialogBody
        displayName={displayName}
        key={open ? 'open' : 'closed'}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />
    </Dialog>
  );
};

DisconnectRootDialog.displayName = 'DisconnectRootDialog';
