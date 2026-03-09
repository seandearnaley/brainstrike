import type { BrowserWindow } from 'electron';

export type DesktopWindowRole = 'chunking-host' | 'embedding-host' | 'visible-ui';

const roleByWebContentsId = new Map<number, DesktopWindowRole>();

export function assignWindowRole(window: BrowserWindow, role: DesktopWindowRole): void {
  const webContentsId = window.webContents.id;
  if (roleByWebContentsId.has(webContentsId)) {
    // Preserve the original closed-listener registration; only the mapped role changes.
    roleByWebContentsId.set(webContentsId, role);
    return;
  }
  roleByWebContentsId.set(webContentsId, role);
  window.once('closed', () => {
    roleByWebContentsId.delete(webContentsId);
  });
}

export function getWindowRoleByWebContentsId(webContentsId: number): DesktopWindowRole | undefined {
  return roleByWebContentsId.get(webContentsId);
}

export function getWindowRole(window: BrowserWindow): DesktopWindowRole | undefined {
  return getWindowRoleByWebContentsId(window.webContents.id);
}
