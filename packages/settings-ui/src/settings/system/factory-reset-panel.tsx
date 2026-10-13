import {
  ClearPersistentUiStateIncompleteError,
  type ClearPersistentUiStateOptions,
  type ClearPersistentUiStateResult,
  clearPersistentUiStateWithResult,
  prepareFactoryReset,
} from '@brainstrike/app-state/factory-reset';
import { useFactoryReset } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { Button, Label, useToast } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';

const logger = createLogger('FactoryResetPanel');

export interface FactoryResetPanelProps {
  doFactoryReset?: (() => Promise<void>) | null;
}

type DesktopResetBridge = () => Promise<{ message?: string; success: boolean }>;
interface DesktopResetCapability {
  readonly resetLocal?: DesktopResetBridge;
  readonly unavailableReason?: string;
}

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

function getDesktopResetCapability(): DesktopResetCapability | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (
    window as Window & {
      electronAPI?: {
        factoryReset?: DesktopResetCapability;
      };
    }
  ).electronAPI?.factoryReset;
}

function getDesktopResetBridge(): DesktopResetBridge | null {
  const resetLocal = getDesktopResetCapability()?.resetLocal;
  return typeof resetLocal === 'function' ? resetLocal : null;
}

function assertPersistentUiStateResetComplete(result: ClearPersistentUiStateResult): void {
  if (result.success) {
    return;
  }

  throw new ClearPersistentUiStateIncompleteError(result);
}

async function clearPersistentUiStateOrThrow(
  options: ClearPersistentUiStateOptions
): Promise<void> {
  assertPersistentUiStateResetComplete(await clearPersistentUiStateWithResult(options));
}

async function runDesktopFactoryReset(desktopResetBridge: DesktopResetBridge): Promise<void> {
  const rendererStorageResetResult = await clearPersistentUiStateWithResult({
    skipIndexedDb: false,
  });
  const result = await desktopResetBridge();
  if (!result.success) {
    throw new Error(result.message ?? 'Desktop factory reset failed.');
  }
  assertPersistentUiStateResetComplete(rendererStorageResetResult);
}

export function FactoryResetPanel({ doFactoryReset = null }: FactoryResetPanelProps) {
  const { toast } = useToast();
  const providerFactoryReset = useFactoryReset({ enabled: !getDesktopResetCapability() });
  const [running, setRunning] = useState(false);
  const resetFn = useMemo(
    () => doFactoryReset ?? providerFactoryReset,
    [doFactoryReset, providerFactoryReset]
  );
  const desktopResetAvailable = getDesktopResetBridge() !== null;
  const unavailableReason = getDesktopResetCapability()?.unavailableReason;
  const resetAvailable =
    !unavailableReason && (desktopResetAvailable || typeof resetFn === 'function');

  const handleClick = useCallback(async () => {
    if (getDesktopResetCapability()?.unavailableReason) {
      return;
    }
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

    let rendererResetStarted = false;
    try {
      setRunning(true);
      if (desktopResetBridge) {
        // Preparation retires renderer writers. Even a failed preparation must
        // reload this renderer; deletion begins only after every writer settles.
        rendererResetStarted = true;
        await prepareFactoryReset();
        // Clear CacheStorage while the live renderer still owns its backing store.
        await runDesktopFactoryReset(desktopResetBridge);
      } else {
        // Direct web/PGlite reset must close/delete the active DB before IndexedDB cleanup.
        if (typeof resetFn !== 'function') {
          throw new Error('Factory reset is unavailable.');
        }
        await resetFn();
        rendererResetStarted = true;
        await clearPersistentUiStateOrThrow({ skipIndexedDb: true });
      }
      // Ensure a full reload so the renderer boots cleanly.
      await requestFactoryResetReload('factory-reset');
    } catch (err) {
      if (rendererResetStarted) {
        logger.error('Factory reset failed after renderer reset preparation began', {
          error: err,
        });
        await requestFactoryResetReload('factory-reset-failed-after-renderer-clear');
        return;
      }
      toast({
        description: String(err),
        title: 'Factory Reset Failed',
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
          {unavailableReason ??
            'Factory reset is unavailable until the database is ready. Restart the app if this does not clear.'}
        </p>
      )}
    </div>
  );
}
