import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';

export interface DisconnectRootDialogProps {
  /** Display name of the root being disconnected (e.g. handle.name). */
  displayName: string;
  /** Called when the user confirms the disconnect. */
  onConfirm: () => void;
  /** Radix-style open state setter (false on cancel/escape/overlay click). */
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * Confirmation dialog for disconnecting a root from the forest sidebar.
 *
 * Disconnect is not delete: the body states that the folder's record is kept,
 * so re-adding the folder later finds it again. Follows the repo's
 * destructive-confirm Dialog pattern.
 */
export const DisconnectRootDialog = ({
  displayName,
  onConfirm,
  onOpenChange,
  open,
}: DisconnectRootDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Disconnect {displayName}?</DialogTitle>
        <DialogDescription>
          This removes the folder from the sidebar. Its saved data is kept, so you can re-add the
          same folder later and it will be available again.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
          Cancel
        </Button>
        <Button onClick={onConfirm} type="button" variant="destructive">
          Disconnect
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

DisconnectRootDialog.displayName = 'DisconnectRootDialog';
