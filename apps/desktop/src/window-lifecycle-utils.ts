import type { BrowserWindow } from 'electron';

/**
 * Resolves on the window's `closed` event, never on a clock (ADR-0026 R4): a
 * window retired with `destroy()` is joined, since Electron's `destroy()`
 * guarantees `closed`. Safe to call on an already-destroyed window.
 *
 * **Important:** Call this BEFORE `window.destroy()`, not after. Electron's
 * `destroy()` synchronously sets `isDestroyed() = true`, so calling this after
 * `destroy()` would hit the early-return path and join nothing.
 */
export function joinWindowClosed(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    window.once('closed', () => resolve());
  });
}
