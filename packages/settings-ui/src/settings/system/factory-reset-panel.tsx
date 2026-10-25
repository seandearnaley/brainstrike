import { createLogger } from '@brainstrike/logging';
import { Button, Label } from '@brainstrike/ui';
import { useCallback, useState } from 'react';

const logger = createLogger('FactoryResetPanel');

type DesktopResetBridge = () => Promise<{ message?: string; success: boolean }>;

function getDesktopResetBridge(): DesktopResetBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const resetLocal = (
    window as Window & {
      electronAPI?: { factoryReset?: { readonly resetLocal?: DesktopResetBridge } };
    }
  ).electronAPI?.factoryReset?.resetLocal;
  return typeof resetLocal === 'function' ? resetLocal : null;
}

/**
 * Desktop Factory Reset. The app records the reset, quits and restarts, and the next start
 * deletes the data before it opens it, so this renderer clears nothing itself. A refused
 * reset deleted nothing and says why.
 */
export function FactoryResetPanel() {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const resetAvailable = getDesktopResetBridge() !== null;

  const handleClick = useCallback(async () => {
    const desktopResetBridge = getDesktopResetBridge();
    if (!desktopResetBridge) {
      return;
    }

    // biome-ignore lint/suspicious/noAlert: Intentional use of confirm for destructive action
    const ok = window.confirm(
      'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Brainstrike restarts to finish. Continue?'
    );
    if (!ok) {
      return;
    }

    setRunning(true);
    setFailure(null);
    let message: string;
    try {
      const result = await desktopResetBridge();
      if (result.success) {
        // The app is quitting; it finishes the reset when it starts again.
        return;
      }
      message = result.message ?? 'Factory reset failed.';
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    logger.error('Factory reset was refused; nothing was deleted', { message });
    setFailure(message);
    setRunning(false);
  }, []);

  return (
    <div className="space-y-1 rounded-md border bg-destructive/5 p-3">
      <Label className="text-destructive text-xs">Factory Reset</Label>
      <p className="text-[11px] text-muted-foreground">
        Irreversibly deletes local data, stored folders, API keys, tool settings, runtime caches,
        and UI state from this device. Diagnostic logs may be preserved. Brainstrike restarts to
        finish.
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
      {failure === null ? null : (
        <p className="mt-1 text-destructive text-xs" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
