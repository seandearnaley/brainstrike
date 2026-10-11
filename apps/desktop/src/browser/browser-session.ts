/**
 * Dedicated session partition for the embedded browser pane (BST-1174).
 *
 * The pane's `WebContentsView`s run on THIS partition, never
 * `session.defaultSession`. Two reasons, one a hard correctness requirement:
 *
 * 1. CORRECTNESS: `setup-security.ts` attaches `onHeadersReceived` to the
 *    default session and overwrites `Content-Security-Policy` (prod:
 *    `default-src 'self'`) + `X-Frame-Options: DENY` on EVERY response. A real
 *    website loaded under that stamp cannot run its own scripts/styles/XHR and
 *    half-renders. A separate partition escapes the stamp, so the pane renders
 *    the live web.
 * 2. CLEAN PROFILE: isolated from the app's own state; no app cookies /
 *    localStorage leak in. A future opt-in "keep me logged in to staging"
 *    profile is BST-1179, gated on the driver migration.
 *
 * SECURITY POSTURE (deny by default): every permission request is DENIED —
 * an allowlist, not a denylist, so a permission absent from any hardcoded set
 * (including permissions Electron adds in future versions) is refused rather
 * than silently granted. Per-origin grants arrive with BST-1178. Downloads are
 * cancelled outright — an embedded pane must not write to the filesystem.
 */
import { createLogger } from '@brainstrike/logging';
import { type Session, session } from 'electron';

const logger = createLogger('BrowserSession');

export const BROWSER_PANE_PARTITION = 'persist:browser-pane';

let configured: Session | null = null;

/**
 * Resolve (and, once, harden) the pane's session partition. Idempotent — the
 * handlers are installed on first call only.
 */
export function getBrowserPaneSession(): Session {
  if (configured) {
    return configured;
  }
  const paneSession = session.fromPartition(BROWSER_PANE_PARTITION);

  // Deny-by-default: refuse EVERY permission request. An allowlist would be
  // required to grant anything; there is none pre-BST-1178.
  paneSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    logger.info('Denied pane permission request', { permission });
    callback(false);
  });
  paneSession.setPermissionCheckHandler(() => false);

  // No filesystem writes from embedded web content: cancel every download.
  paneSession.on('will-download', (event, item) => {
    logger.info('Cancelled pane download', { url: item.getURL() });
    event.preventDefault();
  });

  configured = paneSession;
  logger.info('Browser pane session partition configured', {
    partition: BROWSER_PANE_PARTITION,
  });
  return paneSession;
}

/**
 * Clear both persistent sessions through their owner. Chromium holds its
 * directory open on Windows even after clearing; raw directory deletion is
 * not a substitute for Session.clearData(). Call after renderer preparation
 * and browser-pane disposal, before replacing the visible renderer.
 * https://www.electronjs.org/docs/latest/api/session#sescleardataoptions
 */
export async function clearDesktopBrowserSessions(): Promise<void> {
  const sessions = [session.defaultSession, session.fromPartition(BROWSER_PANE_PARTITION)];
  const results = await Promise.allSettled(
    sessions.map(async (owned) => {
      await owned.clearData();
      await owned.clearAuthCache();
      await owned.closeAllConnections();
    })
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clear desktop browser sessions');
  }
  logger.info('Desktop browser sessions cleared (factory reset)');
}

/** Test-only reset of the memoized session (the module is a singleton). */
export function __resetBrowserPaneSessionForTests(): void {
  configured = null;
}
