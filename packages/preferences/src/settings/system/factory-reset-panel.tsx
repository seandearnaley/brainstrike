import { useFactoryReset } from '@brainstrike/db';
import { Button, Label, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useMemo, useState } from 'react';
import {
  type ClearPersistentUiStateFailure,
  type ClearPersistentUiStateOptions,
  type ClearPersistentUiStateResult,
  clearPersistentUiStateWithResult,
} from './factory-reset-helpers';

const logger = createLogger('FactoryResetPanel');

export interface FactoryResetPanelProps {
  doFactoryReset?: (() => Promise<void>) | null;
}

type DesktopResetBridge = () => Promise<{ message?: string; success: boolean }>;

async function requestFactoryResetReload(reason: string): Promise<void> {
  try {
    const currentWindow = window as Window & {
      desktopLifecycle?: { noteReloadIntent: (reason: string) => Promise<void> };
    };
    await currentWindow.desktopLifecycle?.noteReloadIntent(reason);
    window.location.reload();
  } catch {
    /* swallow reload errors; UI may still be in a reset state */
  }
}

function getDesktopResetBridge(): DesktopResetBridge | null {
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

function describePersistentUiStateFailure(failure: ClearPersistentUiStateFailure): string {
  const name = failure.name ? `:${failure.name}` : '';
  return `${failure.target}:${failure.operation}${name}`;
}

function assertPersistentUiStateResetComplete(result: ClearPersistentUiStateResult): void {
  if (result.success) {
    return;
  }

  const failedTargets = result.failures.map(describePersistentUiStateFailure).join(', ');
  throw new Error(`Factory reset did not clear all renderer storage: ${failedTargets}`);
}

async function clearPersistentUiStateOrThrow(
  options: ClearPersistentUiStateOptions
): Promise<void> {
  assertPersistentUiStateResetComplete(await clearPersistentUiStateWithResult(options));
}

async function runDesktopFactoryReset(desktopResetBridge: DesktopResetBridge): Promise<void> {
  let rendererStorageResetError: unknown;
  let rendererStorageResetResult: ClearPersistentUiStateResult | null = null;
  try {
    rendererStorageResetResult = await clearPersistentUiStateWithResult({ skipIndexedDb: false });
  } catch (error) {
    rendererStorageResetError = error;
  }

  const result = await desktopResetBridge();
  if (!result.success) {
    throw new Error(result.message ?? 'Desktop factory reset failed.');
  }
  if (rendererStorageResetError) {
    throw rendererStorageResetError;
  }
  if (rendererStorageResetResult) {
    assertPersistentUiStateResetComplete(rendererStorageResetResult);
  }
}

export function FactoryResetPanel({ doFactoryReset = null }: FactoryResetPanelProps) {
  const { toast } = useToast();
  const providerFactoryReset = useFactoryReset();
  const [running, setRunning] = useState(false);
  const resetFn = useMemo(
    () => doFactoryReset ?? providerFactoryReset,
    [doFactoryReset, providerFactoryReset]
  );
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

    let rendererStorageResetStarted = false;
    try {
      setRunning(true);
      if (desktopResetBridge) {
        // Desktop CacheStorage must be cleared while the live renderer still owns
        // a valid backing store. Mark the renderer as partially reset before
        // clearing storage because localStorage/sessionStorage are cleared first,
        // which makes same-session toast recovery unreliable.
        rendererStorageResetStarted = true;
        await runDesktopFactoryReset(desktopResetBridge);
      } else {
        // Direct web/PGlite reset must close/delete the active DB before IndexedDB cleanup.
        if (typeof resetFn !== 'function') {
          throw new Error('Factory reset is unavailable.');
        }
        await resetFn();
        rendererStorageResetStarted = true;
        await clearPersistentUiStateOrThrow({ skipIndexedDb: true });
      }
      // Ensure a full reload so the renderer boots cleanly.
      await requestFactoryResetReload('factory-reset');
    } catch (err) {
      if (rendererStorageResetStarted) {
        logger.error('Factory reset failed after renderer storage was already cleared', {
          error: err,
        });
        await requestFactoryResetReload('factory-reset-failed-after-renderer-clear');
        return;
      }
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
