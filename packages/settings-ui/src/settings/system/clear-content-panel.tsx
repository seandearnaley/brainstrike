import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import { startTransition, useActionState, useState } from 'react';

export interface ClearContentProps {
  readonly clearContent: () => Promise<{
    readonly deletedChunks: number | null;
    readonly deletedFiles: number;
  }>;
  /** Joins workspace saves before content goes (the factory-reset preparation). */
  readonly prepare: () => Promise<void>;
  /** Retires the renderer's thread and group stores. */
  readonly retireContent: () => void;
}

/** Deletes the profile's content through Main's content clear; configuration stays. */
export function ClearContentPanel({ clearContent, prepare, retireContent }: ClearContentProps) {
  const [open, setOpen] = useState(false);
  const [error, clear, clearing] = useActionState(async (): Promise<string | null> => {
    try {
      await prepare();
      retireContent();
      await clearContent();
      setOpen(false);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }, null);
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 p-4">
      <h4 className="font-medium text-sm">Clear content</h4>
      <p className="text-muted-foreground text-sm">
        Deletes every chat, prompt, memory and folder, and the search index's data.
      </p>
      <Button onClick={() => setOpen(true)} type="button" variant="outline">
        Clear content…
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear content</DialogTitle>
            <DialogDescription>
              This permanently deletes every chat, prompt, memory, run history, folder and the
              search index's data. Settings, providers and keys stay. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={clearing}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={clearing}
              onClick={() => startTransition(() => clear())}
              type="button"
              variant="destructive"
            >
              {clearing ? 'Clearing…' : 'Clear content'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
