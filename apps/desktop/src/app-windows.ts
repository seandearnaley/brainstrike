import type { BrowserWindow } from 'electron';

const windows = new Map<number, BrowserWindow>();

/** Tracks the app's BrowserWindows by webContents id; a window untracks itself on 'closed'. */
export function trackAppWindow(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  if (windows.has(webContentsId)) {
    return;
  }
  windows.set(webContentsId, window);
  window.once('closed', () => untrackAppWindow(webContentsId));
}

export function isAppWindowSender(webContentsId: number): boolean {
  return windows.has(webContentsId);
}

export function getAppWindows(): BrowserWindow[] {
  const liveWindows: BrowserWindow[] = [];
  for (const [webContentsId, window] of windows) {
    if (window.isDestroyed()) {
      untrackAppWindow(webContentsId);
      continue;
    }
    liveWindows.push(window);
  }
  return liveWindows;
}

export function untrackAppWindow(webContentsId: number): void {
  windows.delete(webContentsId);
}
