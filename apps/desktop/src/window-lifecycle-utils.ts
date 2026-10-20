import type { BrowserWindow } from 'electron';

/**
 * Resolves on the window's `closed` event, never on a clock (ADR-0026 R4): a
 * hidden host retired with `destroy()` is joined, since Electron's `destroy()`
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

/**
 * Resolves when the given window fires its 'closed' event, or after timeoutMs —
 * whichever comes first. Safe to call on an already-destroyed window.
 *
 * **Important:** Call this BEFORE `window.destroy()`, not after. Electron's
 * `destroy()` synchronously sets `isDestroyed() = true`, so calling this after
 * `destroy()` would hit the early-return path and provide zero delay.
 *
 * Used by RendererHostLifecycle.createWindow() to let Chromium release renderer
 * resources before it creates a replacement window. Quit and Stop paths join
 * `closed` with `joinWindowClosed` instead (ADR-0026).
 */
export function waitForWindowClosed(window: BrowserWindow, timeoutMs: number): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        window.removeListener('closed', onClosed);
      } catch {
        // Window may already be destroyed; safe to ignore.
      }
      resolve();
    };
    const onClosed = () => settle();
    const timer = setTimeout(settle, timeoutMs);
    try {
      window.on('closed', onClosed);
    } catch {
      // Window was destroyed between the isDestroyed() check and listener registration.
      settle();
    }
  });
}
