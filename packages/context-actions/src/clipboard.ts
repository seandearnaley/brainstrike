import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { type BoundaryResult, callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { ActionOutcome, ClipboardService } from './types.js';

/**
 * The desktop `window.clipboard` capability (`apps/desktop/src/ipc-domains/
 * clipboard.contract.ts`, BST-1648): `writeText` resolves on success and
 * REJECTS with a clean Error (`message (category · code)`) when main
 * reports a failure — the preload has already unwrapped the IPC envelope.
 */
interface ElectronClipboardBridge {
  writeText?: (text: string) => Promise<BoundaryResult<void>>;
}

type ElectronClipboardWrite = (text: string) => Promise<void>;

function resolveElectronClipboardWrite(): ElectronClipboardWrite | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { clipboard?: ElectronClipboardBridge }).clipboard;
  const writeText = bridge?.writeText;
  return typeof writeText === 'function' ? (text) => callBoundary(() => writeText(text)) : null;
}

async function writeViaElectronBridge(
  electronWriteText: ElectronClipboardWrite,
  text: string
): Promise<ActionOutcome> {
  try {
    await electronWriteText(text);
    return { ok: true };
  } catch (error) {
    return {
      error: describeBoundaryError(error),
      ok: false,
    };
  }
}

async function writeViaNavigatorClipboard(text: string): Promise<ActionOutcome> {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Clipboard write failed',
      ok: false,
    };
  }
}

export function createClipboardService(): ClipboardService {
  return {
    async writeText(text: string): Promise<ActionOutcome> {
      const electronWriteText = resolveElectronClipboardWrite();
      if (electronWriteText) {
        // A present-but-failing bridge is a bug to surface, not to mask with
        // the web API (no silent fallbacks).
        return await writeViaElectronBridge(electronWriteText, text);
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        return await writeViaNavigatorClipboard(text);
      }
      return { error: 'No clipboard available in this environment', ok: false };
    },
  };
}
