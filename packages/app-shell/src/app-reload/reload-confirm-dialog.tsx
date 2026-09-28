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

function describeRuns(runningCount: number | null): string {
  if (runningCount === null) {
    return "BrainStrike can't confirm whether assistant runs are in progress. Reloading now stops any that are.";
  }
  return runningCount === 1
    ? '1 assistant run is still in progress. Reloading now stops it.'
    : `${runningCount} assistant runs are still in progress. Reloading now stops them.`;
}

/**
 * Confirms a reload that would stop assistant work. `runningCount` is `null`
 * when the count could not be read: the copy then says so, and there is no
 * "Reload when finished", because there is nothing to wait on.
 */
export function ReloadConfirmDialog({
  onCancel,
  onReloadNow,
  onReloadWhenFinished,
  runningCount,
}: {
  readonly onCancel: () => void;
  readonly onReloadNow: () => void;
  readonly onReloadWhenFinished: () => void;
  readonly runningCount: number | null;
}): ReactElement {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-[440px]" data-testid="app-reload-dialog">
        <DialogHeader>
          <DialogTitle>Reload BrainStrike?</DialogTitle>
          <DialogDescription>{describeRuns(runningCount)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={onReloadNow} type="button" variant="destructive">
            Reload now
          </Button>
          {runningCount === null ? null : (
            <Button onClick={onReloadWhenFinished} type="button">
              Reload when finished
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
