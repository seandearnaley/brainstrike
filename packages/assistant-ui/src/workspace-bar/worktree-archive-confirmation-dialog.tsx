import type { WorktreeArchivePreview } from '@brainstrike/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import type { ReactElement } from 'react';

export interface WorktreeArchiveConfirmation {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly preview: WorktreeArchivePreview;
  readonly worktreeName: string;
}

export function WorktreeArchiveConfirmationDialog({
  confirmation,
}: {
  readonly confirmation: WorktreeArchiveConfirmation;
}): ReactElement {
  const { preview } = confirmation;
  const noun = preview.ignoredEntryCount === 1 ? 'entry' : 'entries';
  const hiddenTopLevelEntryCount =
    preview.ignoredTopLevelEntryCount - preview.ignoredTopLevelEntries.length;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          confirmation.onCancel();
        }
      }}
      open
    >
      <DialogContent data-testid="worktree-archive-ignored-confirmation">
        <DialogHeader>
          <DialogTitle>Delete ignored files and archive?</DialogTitle>
          <DialogDescription>
            Archiving “{confirmation.worktreeName}” will permanently delete{' '}
            {preview.ignoredEntryCount} ignored {noun}. Ignored files are not included in the
            archive snapshot and cannot be recovered by BrainStrike.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="font-medium text-sm">Ignored top-level paths</p>
          <ul className="mt-2 list-inside list-disc font-mono text-xs">
            {preview.ignoredTopLevelEntries.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          {preview.ignoredTopLevelEntriesTruncated && hiddenTopLevelEntryCount > 0 ? (
            <p className="mt-2 text-muted-foreground text-xs">
              {hiddenTopLevelEntryCount} additional top-level{' '}
              {hiddenTopLevelEntryCount === 1 ? 'path is' : 'paths are'} hidden.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={confirmation.onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={confirmation.onConfirm} type="button" variant="destructive">
            Delete ignored files and archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
