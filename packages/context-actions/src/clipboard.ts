import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { type BoundaryResult, callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { ActionOutcome, SystemClipboard } from './types.js';

/**
 * The desktop `window.clipboard` capability (`apps/desktop/src/ipc-domains/
 * clipboard.contract.ts`, BST-1648): `writeText` resolves on success and
 * REJECTS with a clean Error (`message (category · code)`) when main
 * reports a failure — the preload has already unwrapped the IPC envelope.
 */
interface ElectronClipboardBridge {
  writeImage?: (png: Uint8Array) => Promise<BoundaryResult<void>>;
  writeText?: (text: string) => Promise<BoundaryResult<void>>;
}

function resolveElectronClipboardBridge(): ElectronClipboardBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as Window & { clipboard?: ElectronClipboardBridge }).clipboard ?? null;
}

async function writeViaElectronBridge(write: () => Promise<void>): Promise<ActionOutcome> {
  try {
    await write();
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

async function writeImageViaNavigatorClipboard(png: Promise<Blob>): Promise<ActionOutcome> {
  try {
    // The PNG goes in as a promise so the write starts inside the user's
    // gesture while the image is still being drawn (Async Clipboard API).
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Clipboard write failed',
      ok: false,
    };
  }
}

export function createClipboardService(): SystemClipboard {
  return {
    async writeImage(png: Promise<Blob>): Promise<ActionOutcome> {
      const bridge = resolveElectronClipboardBridge();
      if (bridge) {
        const { writeImage } = bridge;
        if (typeof writeImage !== 'function') {
          return { error: 'The desktop clipboard cannot take images', ok: false };
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await (await png).arrayBuffer());
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), ok: false };
        }
        return await writeViaElectronBridge(() => callBoundary(() => writeImage(bytes)));
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        return await writeImageViaNavigatorClipboard(png);
      }
      return { error: 'No clipboard available in this environment', ok: false };
    },
    async writeText(text: string): Promise<ActionOutcome> {
      const writeText = resolveElectronClipboardBridge()?.writeText;
      if (typeof writeText === 'function') {
        // A present-but-failing bridge is a bug to surface, not to mask with
        // the web API (no silent fallbacks).
        return await writeViaElectronBridge(() => callBoundary(() => writeText(text)));
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        return await writeViaNavigatorClipboard(text);
      }
      return { error: 'No clipboard available in this environment', ok: false };
    },
  };
}
