import type { BrowserWindow } from 'electron';

export type DesktopWindowRole = 'chunking-host' | 'embedding-host' | 'visible-ui';

const roleByWebContentsId = new Map<number, DesktopWindowRole>();
const windowByWebContentsId = new Map<number, BrowserWindow>();
const webContentsIdsByRole = new Map<DesktopWindowRole, Set<number>>([
  ['chunking-host', new Set<number>()],
  ['embedding-host', new Set<number>()],
  ['visible-ui', new Set<number>()],
]);

function removeWindowTracking(webContentsId: number): void {
  const previousRole = roleByWebContentsId.get(webContentsId);
  if (previousRole) {
    webContentsIdsByRole.get(previousRole)?.delete(webContentsId);
  }
  roleByWebContentsId.delete(webContentsId);
  windowByWebContentsId.delete(webContentsId);
}

export function assignWindowRole(window: BrowserWindow, role: DesktopWindowRole): void {
  const webContentsId = window.webContents.id;
  const previousRole = roleByWebContentsId.get(webContentsId);
  if (previousRole && previousRole !== role) {
    webContentsIdsByRole.get(previousRole)?.delete(webContentsId);
  }
  windowByWebContentsId.set(webContentsId, window);
  webContentsIdsByRole.get(role)?.add(webContentsId);
  if (roleByWebContentsId.has(webContentsId)) {
    // Preserve the original closed-listener registration; only the mapped role changes.
    roleByWebContentsId.set(webContentsId, role);
    return;
  }
  roleByWebContentsId.set(webContentsId, role);
  window.once('closed', () => {
    removeWindowTracking(webContentsId);
  });
}

export function getWindowRoleByWebContentsId(webContentsId: number): DesktopWindowRole | undefined {
  return roleByWebContentsId.get(webContentsId);
}

export function getWindowRole(window: BrowserWindow): DesktopWindowRole | undefined {
  return getWindowRoleByWebContentsId(window.webContents.id);
}

export function getTrackedWindowsByRole(role: DesktopWindowRole): BrowserWindow[] {
  const trackedIds = webContentsIdsByRole.get(role);
  if (!trackedIds) {
    return [];
  }
  const windows: BrowserWindow[] = [];
  for (const webContentsId of trackedIds) {
    const window = windowByWebContentsId.get(webContentsId);
    if (!window || window.isDestroyed()) {
      removeWindowTracking(webContentsId);
      continue;
    }
    windows.push(window);
  }
  return windows;
}

export function clearWindowRoleByWebContentsId(webContentsId: number): void {
  removeWindowTracking(webContentsId);
}
