import { createLogger } from '@brainstrike/logging';
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
import { reloadThroughLifecycle } from './reload-through-lifecycle';

const logger = createLogger('ClearContentPanel');

export interface ClearContentProps {
  readonly clearContent: () => Promise<void>;
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
  // Once a clear starts the window's stores are retiring: the dialog cannot be
  // dismissed while it runs, and a failure stays on screen until the user reloads.
  const failed = error !== null;
  return (
    <div className="border-destructive/40 space-y-2 rounded-md border p-4">
      <h4 className="text-sm font-medium">Clear content</h4>
      <p className="text-muted-foreground text-sm">
        Deletes every chat, prompt, memory and folder, and the search index's data.
      </p>
      <Button onClick={() => setOpen(true)} type="button" variant="outline">
        Clear content…
      </Button>
      <Dialog onOpenChange={(next) => setOpen(next || failed || clearing)} open={open || failed}>
        <DialogContent hideCloseButton={failed}>
          <DialogHeader>
            <DialogTitle>Clear content</DialogTitle>
            <DialogDescription>
              This permanently deletes every chat, prompt, memory, run history, folder and the
              search index's data. Settings, providers and keys stay. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {/* ADR-0034: the clear archives the managed worktrees, forcing past their ignored
              files, and moves the scratch folders to the Trash. */}
          <p className="text-muted-foreground text-sm">
            Managed worktrees are archived into their repositories first: uncommitted work is kept
            as a snapshot ref and their branches stay, but their ignored files, such as .env files
            and installed dependencies, are deleted. Scratch folders, made for chats started with no
            folder open, are moved to the Trash.
          </p>
          {failed ? (
            <>
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
              <p className="text-muted-foreground text-sm">Reload Brainstrike to continue.</p>
            </>
          ) : null}
          <DialogFooter>
            {failed ? (
              <Button
                onClick={() => {
                  void reloadThroughLifecycle('content-clear-failed-after-preparation', logger);
                }}
                type="button"
              >
                Reload
              </Button>
            ) : (
              <>
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
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
