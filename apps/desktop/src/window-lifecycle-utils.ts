import type { BrowserWindow } from 'electron';

/**
 * Resolves when the given window fires its 'closed' event, or after timeoutMs —
 * whichever comes first. Safe to call on an already-destroyed window.
 *
 * Used by both ChunkingHostManager.stop() and RendererHostLifecycle.createWindow()
 * to ensure Chromium has released renderer resources before creating a new window.
 */
export function waitForWindowClosed(window: BrowserWindow, timeoutMs: number): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    try {
      window.once('closed', () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      // Window was destroyed between the isDestroyed() check and listener registration.
      clearTimeout(timer);
      resolve();
    }
  });
}
