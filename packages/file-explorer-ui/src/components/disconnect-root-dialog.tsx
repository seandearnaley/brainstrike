import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import type * as React from 'react';

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
 * Disconnect ≠ delete: the body explicitly states that indexed data is KEPT
 * and the folder can be re-added later (re-adding resumes without
 * re-indexing). Mirrors the repo's destructive-confirm Dialog pattern
 * (see delete-embedding-set-dialog.tsx in vector-management).
 */
export const DisconnectRootDialog: React.FC<DisconnectRootDialogProps> = ({
  displayName,
  onConfirm,
  onOpenChange,
  open,
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Disconnect {displayName}?</DialogTitle>
        <DialogDescription>
          This removes the folder from the sidebar. Its indexed data is kept, so you can re-add the
          same folder later and it will be available again without re-indexing.
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
