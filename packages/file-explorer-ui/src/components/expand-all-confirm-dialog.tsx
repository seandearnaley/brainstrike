/**
 * Forest Expand All confirmation.
 *
 * Expanding every folder across a multi-root workspace scans every
 * subdirectory of every root sequentially — an I/O-heavy sweep that is easy
 * to trigger by accident from the toolbar. Multi-root runs stage behind this
 * explicit confirm; single-root expand-all stays immediate (the sweep is
 * bounded to one tree and cancellable from the inline scanning indicator).
 */

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

export function ExpandAllConfirmDialog({
  onCancel,
  onConfirm,
  open,
  rootCount,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  rootCount: number;
}): React.ReactNode {
  return (
    <Dialog onOpenChange={(next) => !next && onCancel()} open={open}>
      <DialogContent className="sm:max-w-[440px]" data-testid="expand-all-confirm-dialog">
        <DialogHeader>
          <DialogTitle>Expand all folders?</DialogTitle>
          <DialogDescription>
            This workspace has {rootCount} root folders. Expand All scans every subdirectory in each
            of them, which can take a while on large trees. A running expansion can be stopped with
            Collapse All.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button data-testid="expand-all-confirm-cancel" onClick={onCancel} variant="outline">
            Cancel
          </Button>
          <Button data-testid="expand-all-confirm-run" onClick={onConfirm}>
            Expand all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
