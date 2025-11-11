import { useFactoryReset } from '@brainstrike/db';
import { Button, Label, useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
import { clearPersistentUiState } from './factory-reset-helpers';

export interface FactoryResetPanelProps {
  doFactoryReset?: (() => Promise<void>) | null;
}

export function FactoryResetPanel({ doFactoryReset = null }: FactoryResetPanelProps) {
  const { toast } = useToast();
  const providerFactoryReset = useFactoryReset();
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    const ok = window.confirm(
      'Factory Reset will wipe all data (files, chunks, embedding sets, job queue), dispose embeddings, and reload the database. Continue?'
    );
    if (!ok) return;

    try {
      setRunning(true);
      // Prefer provider-level factory reset if available so DB purge occurs before UI state is removed.
      const resetFn = doFactoryReset ?? providerFactoryReset;
      if (typeof resetFn === 'function') {
        await resetFn();
      }
      // Clear renderer persistent UI state after provider reset to avoid rehydrating stale stores.
      await clearPersistentUiState();
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
    <div className="border rounded-md p-3 bg-destructive/5 space-y-1">
      <Label className="text-xs text-destructive">Factory Reset</Label>
      <p className="text-[11px] text-muted-foreground">
        Clears all files, embeddings, queues, and local preferences. The app will reload after the
        reset completes.
      </p>
      <Button
        size="sm"
        variant="destructive"
        className="h-6 mt-1"
        onClick={handleClick}
        data-testid="factory-reset-button"
        disabled={running || !(doFactoryReset ?? providerFactoryReset)}
      >
        Factory Reset Brainstrike
      </Button>
      {!(doFactoryReset ?? providerFactoryReset) ? (
        <p className="text-xs text-muted-foreground mt-1">
          Factory reset unavailable until the database is ready.
        </p>
      ) : null}
    </div>
  );
}
