import { useFactoryReset } from '@brainstrike/db';
import { Button, Label, useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
import { clearPersistentUiState } from './factory-reset-helpers';

export interface FactoryResetPanelProps {
  doFactoryReset?: (() => Promise<void>) | null;
}

function getDesktopResetBridge(): (() => Promise<{ message?: string; success: boolean }>) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const resetLocal = (
    window as Window & {
      electronAPI?: {
        db?: {
          resetLocal?: () => Promise<{ message?: string; success: boolean }>;
        };
      };
    }
  ).electronAPI?.db?.resetLocal;
  return typeof resetLocal === 'function' ? resetLocal : null;
}

export function FactoryResetPanel({ doFactoryReset = null }: FactoryResetPanelProps) {
  const { toast } = useToast();
  const providerFactoryReset = useFactoryReset();
  const [running, setRunning] = useState(false);
  const resetFn = doFactoryReset ?? providerFactoryReset;
  const desktopResetAvailable = getDesktopResetBridge() !== null;
  const resetAvailable = desktopResetAvailable || typeof resetFn === 'function';

  const handleClick = useCallback(async () => {
    const desktopResetBridge = getDesktopResetBridge();
    if (!(desktopResetBridge || typeof resetFn === 'function')) {
      return;
    }

    // biome-ignore lint/suspicious/noAlert: Intentional use of confirm for destructive action
    const ok = window.confirm(
      'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Continue?'
    );
    if (!ok) {
      return;
    }

    try {
      setRunning(true);
      if (desktopResetBridge) {
        const result = await desktopResetBridge();
        if (!result.success) {
          throw new Error(result.message ?? 'Desktop factory reset failed.');
        }
        // Clear live renderer stores after main confirms the destructive reset completed.
        await clearPersistentUiState({ skipIndexedDb: false });
      } else {
        // Direct web/PGlite reset must close/delete the active DB before IndexedDB cleanup.
        if (typeof resetFn !== 'function') {
          throw new Error('Factory reset is unavailable.');
        }
        await resetFn();
        await clearPersistentUiState({ skipIndexedDb: true });
      }
      // Ensure a full reload so the renderer boots cleanly.
      try {
        const currentWindow = window as Window & {
          desktopLifecycle?: { noteReloadIntent: (reason: string) => Promise<void> };
        };
        await currentWindow.desktopLifecycle?.noteReloadIntent('factory-reset');
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
  }, [resetFn, toast]);

  return (
    <div className="space-y-1 rounded-md border bg-destructive/5 p-3">
      <Label className="text-destructive text-xs">Factory Reset</Label>
      <p className="text-[11px] text-muted-foreground">
        Irreversibly deletes local data, stored folders, API keys, tool settings, runtime caches,
        and UI state from this device. Diagnostic logs may be preserved.
      </p>
      <Button
        className="mt-1 h-6"
        data-testid="factory-reset-button"
        disabled={running || !resetAvailable}
        onClick={handleClick}
        size="sm"
        variant="destructive"
      >
        Factory Reset Brainstrike
      </Button>
      {resetAvailable ? null : (
        <p className="mt-1 text-muted-foreground text-xs">
          Factory reset is unavailable until the database is ready. Restart the app if this does not
          clear.
        </p>
      )}
    </div>
  );
}
