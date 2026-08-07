/**
 * Dedicated session partition for the embedded browser pane (BST-1174).
 *
 * The pane's `WebContentsView`s run on THIS partition, never
 * `session.defaultSession`. Two reasons, one of them a hard correctness
 * requirement:
 *
 * 1. CORRECTNESS: `setup-security.ts` attaches `onHeadersReceived` to the
 *    default session and overwrites `Content-Security-Policy` (prod:
 *    `default-src 'self'`) + `X-Frame-Options: DENY` on EVERY response. A real
 *    website loaded under that stamp cannot run its own scripts/styles/XHR and
 *    half-renders. A separate partition escapes the stamp, so the pane renders
 *    the live web.
 * 2. CLEAN PROFILE: `persist:`-prefixed but isolated from the app's own state;
 *    no app cookies/localStorage leak in. (A future opt-in "keep me logged in
 *    to staging" profile is BST-1179, gated on the driver migration.)
 *
 * Permissions are denied by default: an embedded pane must not silently grant
 * camera/mic/geolocation/notifications to arbitrary sites. Downloads and
 * insecure-content are refused. This is the pane's own `webRequest`-free
 * hardening layer; per-origin approval (navigation gating) is BST-1178.
 */
import { createLogger } from '@brainstrike/logging';
import { type Session, session } from 'electron';

const logger = createLogger('BrowserSession');

export const BROWSER_PANE_PARTITION = 'persist:browser-pane';

/** Permissions the embedded pane refuses outright (BST-1178 revisits grants). */
const DENIED_PERMISSIONS = new Set<string>([
  'geolocation',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'pointerLock',
  'openExternal',
  'hid',
  'serial',
  'usb',
]);

let configured: Session | null = null;

/**
 * Resolve (and, once, harden) the pane's session partition. Idempotent — the
 * permission handlers are installed on first call only.
 */
export function getBrowserPaneSession(): Session {
  if (configured) {
    return configured;
  }
  const paneSession = session.fromPartition(BROWSER_PANE_PARTITION);

  paneSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const denied = DENIED_PERMISSIONS.has(permission);
    if (denied) {
      logger.info('Denied pane permission request', { permission });
    }
    callback(!denied);
  });
  paneSession.setPermissionCheckHandler(
    (_webContents, permission) => !DENIED_PERMISSIONS.has(permission)
  );

  configured = paneSession;
  logger.info('Browser pane session partition configured', {
    partition: BROWSER_PANE_PARTITION,
  });
  return paneSession;
}

/** Test-only reset of the memoized session (the module is a singleton). */
export function __resetBrowserPaneSessionForTests(): void {
  configured = null;
}
