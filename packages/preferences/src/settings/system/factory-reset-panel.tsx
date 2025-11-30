import { useFactoryReset } from '@brainstrike/db';
import { Button, Label, useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
import { clearPersistentUiState } from './factory-reset-helpers';

export type FactoryResetPanelProps = {
  doFactoryReset?: (() => Promise<void>) | null;
};

export function FactoryResetPanel({ doFactoryReset = null }: FactoryResetPanelProps) {
  const { toast } = useToast();
  const providerFactoryReset = useFactoryReset();
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    // biome-ignore lint/suspicious/noAlert: Intentional use of confirm for destructive action
    const ok = window.confirm(
      'Factory Reset will wipe all data (files, chunks, embedding sets, job queue), dispose embeddings, and reload the database. Continue?'
    );
    if (!ok) {
      return;
    }

    try {
      setRunning(true);
      // Prefer provider-level factory reset if available so DB purge occurs before UI state is removed.
      const resetFn = doFactoryReset ?? providerFactoryReset;
      let skipIndexedDb = false;
      if (typeof resetFn === 'function') {
        await resetFn();
        skipIndexedDb = true;
      }
      // Clear renderer persistent UI state after provider reset to avoid rehydrating stale stores.
      await clearPersistentUiState({ skipIndexedDb });
      // Ensure a full reload so the renderer boots cleanly.
      try {
        window.location.reload();
      } catch {
        /* swallow reload errors; UI may still be in a reset state */
      }
    } catch (err) {
      toast({
        title: 'Factory Reset Failed',
        description: String(err),
        variant: 'destructive',
      });
      setRunning(false);
    }
  }, [doFactoryReset, providerFactoryReset, toast]);

  return (
    <div className="space-y-1 rounded-md border bg-destructive/5 p-3">
      <Label className="text-destructive text-xs">Factory Reset</Label>
      <p className="text-[11px] text-muted-foreground">
        Clears all files, embeddings, queues, and local preferences. The app will reload after the
        reset completes.
      </p>
      <Button
        className="mt-1 h-6"
        data-testid="factory-reset-button"
        disabled={running}
        onClick={handleClick}
        size="sm"
        variant="destructive"
      >
        Factory Reset Brainstrike
      </Button>
      {(doFactoryReset ?? providerFactoryReset) ? null : (
        <p className="mt-1 text-muted-foreground text-xs">
          Database-level reset is unavailable, so this will only clear the UI state before
          reloading.
        </p>
      )}
    </div>
  );
}
