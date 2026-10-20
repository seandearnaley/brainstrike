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
import { EGRESS_REFUSAL_HEADER } from './agent-egress/egress-proxy';
import { type LoopbackAdmission, loopbackRequestAllowed } from './browser-url';

const logger = createLogger('BrowserSession');

export const BROWSER_PANE_PARTITION = 'persist:browser-pane';

/**
 * Agent tabs' partition (BST-1238). In memory: agent browsing keeps no
 * cookies or storage across launches, and it never shares the user tabs'.
 */
export const AGENT_BROWSER_PARTITION = 'browser-pane-agent';

let configured: Session | null = null;
let agentConfigured: Session | null = null;
let agentProxyPort: number | null = null;
/** BST-1178: the loopback server the agent's current navigation may reach, if any. */
let agentLoopback: LoopbackAdmission | null = null;

function harden(paneSession: Session): void {
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
}

/**
 * Resolve (and, once, harden) the pane's session partition. Idempotent — the
 * handlers are installed on first call only.
 */
export function getBrowserPaneSession(): Session {
  if (configured) {
    return configured;
  }
  const paneSession = session.fromPartition(BROWSER_PANE_PARTITION);
  harden(paneSession);
  configured = paneSession;
  logger.info('Browser pane session partition configured', {
    partition: BROWSER_PANE_PARTITION,
  });
  return paneSession;
}

/** A plain-http response the egress proxy refused, in the tab that asked for it. */
export interface RefusedAgentResponse {
  readonly isMainFrame: boolean;
  readonly refusal: string;
  readonly url: string;
  readonly webContentsId: number;
}

function refusalHeader(headers: Record<string, string[]> | undefined): string | undefined {
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === EGRESS_REFUSAL_HEADER) {
      return values[0];
    }
  }
  return undefined;
}

/**
 * Route the agent partition through the egress proxy on `proxyPort`, hardened
 * like the pane's (BST-1238). The proxy is its only route out:
 * `<-loopback>` removes Chromium's implicit direct route for localhost and
 * link-local, so those connections meet the proxy's policy too.
 *
 * A refused https or WebSocket connection fails as a tunnel error. A refused
 * plain-http request instead gets the proxy's empty 403, which this cancels
 * so the load fails visibly rather than rendering a blank page; `onRefused`
 * names the tab and the refused class.
 *
 * BST-1178: `loopback` is the one loopback server the navigation about to
 * open may reach, which the proxy admits for every agent tab. This session
 * lets requests for it through only from that tab's approved page
 * ({@link loopbackRequestAllowed}) and cancels the rest.
 */
export async function routeAgentBrowserSession(
  proxyPort: number,
  onRefused: (response: RefusedAgentResponse) => void,
  loopback: LoopbackAdmission | null = null
): Promise<Session> {
  const agentSession = agentConfigured ?? session.fromPartition(AGENT_BROWSER_PARTITION);
  if (agentConfigured === null) {
    harden(agentSession);
    agentSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !loopbackRequestAllowed(details, agentLoopback) });
    });
    agentSession.webRequest.onHeadersReceived((details, callback) => {
      const refusal = refusalHeader(details.responseHeaders);
      if (refusal === undefined) {
        callback({});
        return;
      }
      if (details.webContentsId !== undefined) {
        onRefused({
          isMainFrame: details.resourceType === 'mainFrame',
          refusal,
          url: details.url,
          webContentsId: details.webContentsId,
        });
      }
      callback({ cancel: true });
    });
    agentConfigured = agentSession;
  }
  agentLoopback = loopback;
  if (agentProxyPort !== proxyPort) {
    await agentSession.setProxy({
      mode: 'fixed_servers',
      proxyBypassRules: '<-loopback>',
      proxyRules: `127.0.0.1:${proxyPort}`,
    });
    // Pooled sockets from a previous proxy must not outlive its route.
    await agentSession.closeAllConnections();
    agentProxyPort = proxyPort;
    logger.info('Agent browser partition routed through its egress proxy', {
      partition: AGENT_BROWSER_PARTITION,
    });
  }
  return agentSession;
}

/**
 * Clear the app, pane and agent sessions through their owner. Chromium holds its
 * directory open on Windows even after clearing; raw directory deletion is
 * not a substitute for Session.clearData(). Call after renderer preparation
 * and browser-pane disposal, before replacing the visible renderer.
 * https://www.electronjs.org/docs/latest/api/session#sescleardataoptions
 */
export async function clearDesktopBrowserSessions(): Promise<void> {
  const sessions = [
    session.defaultSession,
    session.fromPartition(BROWSER_PANE_PARTITION),
    session.fromPartition(AGENT_BROWSER_PARTITION),
  ];
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

/** Test-only reset of the memoized session (the module is a singleton).
 * @internal Isolates browser-pane session lifecycle regressions.
 */
export function __resetBrowserPaneSessionForTests(): void {
  configured = null;
  agentConfigured = null;
  agentProxyPort = null;
  agentLoopback = null;
}
