import { prepareFactoryReset } from '@brainstrike/app-state/factory-reset';
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
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const desktopResetAvailable = getDesktopResetBridge() !== null;
  const unavailableReason = getDesktopResetCapability()?.unavailableReason;
  const resetAvailable = !unavailableReason && desktopResetAvailable;

  const runReset = async () => {
    if (getDesktopResetCapability()?.unavailableReason) {
      return;
    }
    const desktopResetBridge = getDesktopResetBridge();
    if (!desktopResetBridge) {
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
    <div className="border-destructive/40 space-y-2 rounded-md border p-4">
      <h4 className="text-sm font-medium">Factory reset</h4>
      <p className="text-muted-foreground text-sm">
        Irreversibly deletes local data, stored folders, API keys, tool settings, runtime caches,
        and UI state from this device. Diagnostic logs may be preserved.
      </p>
      <Button
        data-testid="factory-reset-button"
        disabled={running || !resetAvailable}
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        Factory reset…
      </Button>
      {resetAvailable ? null : (
        <p className="text-muted-foreground text-sm">
          {unavailableReason ??
            'Factory reset is unavailable until the database is ready. Restart the app if this does not clear.'}
        </p>
      )}
      {/* Once the reset starts this window's stores are retiring and it reloads either
          way, so the dialog cannot be dismissed while it runs. */}
      <Dialog onOpenChange={(next) => setOpen(next || running)} open={open || running}>
        <DialogContent hideCloseButton={running}>
          <DialogHeader>
            <DialogTitle>Factory reset</DialogTitle>
            <DialogDescription>
              This permanently deletes local threads, stored folders, API keys, tool settings,
              runtime caches and UI state from this device, then reloads Brainstrike. Diagnostic
              logs may be preserved. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={running}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="factory-reset-confirm"
              disabled={running}
              onClick={() => {
                void runReset();
              }}
              type="button"
              variant="destructive"
            >
              {running ? 'Resetting…' : 'Factory reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
