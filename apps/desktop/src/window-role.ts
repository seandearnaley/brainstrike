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

/** Fallback `sourceWindowRole` binding value for a webContents id with no
 * tracked role (untracked sender, or a race between window teardown and an
 * in-flight IPC message). Deliberately NOT `'visible-ui'`: claiming an
 * unknown-origin record came from the visible UI is an unverified,
 * misleading attribution the "no guessing" rule forbids — the safe default
 * under-attributes instead. */
export const UNKNOWN_SOURCE_WINDOW_ROLE = 'hidden-host';

/**
 * Resolves the `sourceWindowRole` binding stamped onto a forwarded log
 * record, given the webContents id that sent it. The SINGLE shared
 * implementation for both call sites that stamp this binding on the SAME
 * incoming `ingestBufferedRecord` IPC message: `logging-ipc.ts`'s
 * durable-push enrichment (feeds the NDJSON backstop / DB row `source`) and
 * `main.ts`'s buffered-log ingest handler (feeds the session/buffered Log
 * Viewer source). Two independent inline `getWindowRoleByWebContentsId(id)
 * ?? '...'` fallbacks previously used DIFFERENT literals here, so the same
 * record could show one `sourceWindowRole` in the durable view and another
 * in the session view for an untracked sender — route every caller through
 * this function instead of inlining a fallback so the two paths can never
 * diverge again.
 */
export function resolveSourceWindowRole(webContentsId: number): string {
  return getWindowRoleByWebContentsId(webContentsId) ?? UNKNOWN_SOURCE_WINDOW_ROLE;
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
  const staleIds: number[] = [];
  for (const webContentsId of trackedIds) {
    const window = windowByWebContentsId.get(webContentsId);
    if (!window || window.isDestroyed()) {
      staleIds.push(webContentsId);
      continue;
    }
    windows.push(window);
  }
  for (const staleId of staleIds) {
    removeWindowTracking(staleId);
  }
  return windows;
}

export function clearWindowRoleByWebContentsId(webContentsId: number): void {
  removeWindowTracking(webContentsId);
}
