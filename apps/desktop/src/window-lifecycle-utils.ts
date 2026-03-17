import type { BrowserWindow } from 'electron';

/**
 * Resolves when the given window fires its 'closed' event, or after timeoutMs —
 * whichever comes first. Safe to call on an already-destroyed window.
 *
 * **Important:** Call this BEFORE `window.destroy()`, not after. Electron's
 * `destroy()` synchronously sets `isDestroyed() = true`, so calling this after
 * `destroy()` would hit the early-return path and provide zero delay.
 *
 * Used by both ChunkingHostManager.stop() and RendererHostLifecycle.createWindow()
 * to ensure Chromium has released renderer resources before creating a new window.
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
      window.once('closed', onClosed);
    } catch {
      // Window was destroyed between the isDestroyed() check and listener registration.
      settle();
    }
  });
}
