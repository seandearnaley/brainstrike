import { prepareFactoryReset } from '@brainstrike/app-state/factory-reset';
import { createLogger } from '@brainstrike/logging';
import { Button } from '@brainstrike/ui';
import { useState } from 'react';
import { reloadThroughLifecycle } from './reload-through-lifecycle';

const logger = createLogger('FactoryResetPanel');

type DesktopResetBridge = () => Promise<{ message?: string; success: boolean }>;
interface DesktopResetCapability {
  readonly resetLocal?: DesktopResetBridge;
  readonly unavailableReason?: string;
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

/**
 * Main owns the reset: it wipes the profile and, once this document is gone, the
 * session's storage, then loads a fresh one. Session storage belongs to the window
 * rather than the session, so it is the one store this document clears itself.
 */
async function runDesktopFactoryReset(desktopResetBridge: DesktopResetBridge): Promise<void> {
  window.sessionStorage.clear();
  const result = await desktopResetBridge();
  if (!result.success) {
    throw new Error(result.message ?? 'Factory reset failed.');
  }
}

export function FactoryResetPanel() {
  const [running, setRunning] = useState(false);
  const desktopResetAvailable = getDesktopResetBridge() !== null;
  const unavailableReason = getDesktopResetCapability()?.unavailableReason;
  const resetAvailable = !unavailableReason && desktopResetAvailable;

  const handleClick = async () => {
    if (getDesktopResetCapability()?.unavailableReason) {
      return;
    }
    const desktopResetBridge = getDesktopResetBridge();
    if (!desktopResetBridge) {
      return;
    }

    // biome-ignore lint/suspicious/noAlert: Intentional use of confirm for destructive action
    const ok = window.confirm(
      'Factory Reset will irreversibly delete local threads, stored folders, API keys, tool settings, runtime caches, and UI state from this device. Diagnostic logs may be preserved. Continue?'
    );
    if (!ok) {
      return;
    }

    try {
      setRunning(true);
      // Preparation retires renderer writers. Even a failed preparation must
      // reload this renderer; deletion begins only after every writer settles.
      await prepareFactoryReset();
      await runDesktopFactoryReset(desktopResetBridge);
      // Ensure a full reload so the renderer boots cleanly.
      await reloadThroughLifecycle('factory-reset', logger);
    } catch (err) {
      logger.error('Factory reset failed after renderer reset preparation began', {
        error: err,
      });
      await reloadThroughLifecycle('factory-reset-failed', logger);
    }
  };

  return (
    <div className="bg-destructive/5 space-y-1 rounded-md border p-3">
      <p className="text-destructive text-xs leading-none font-medium">Factory Reset</p>
      <p className="text-muted-foreground text-[11px]">
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
        <p className="text-muted-foreground mt-1 text-xs">
          {unavailableReason ??
            'Factory reset is unavailable until the database is ready. Restart the app if this does not clear.'}
        </p>
      )}
    </div>
  );
}
