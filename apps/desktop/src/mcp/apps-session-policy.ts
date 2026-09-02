/**
 * Session-level permission and download policy for the opaque-origin sandbox
 * frames the main window hosts (BST-1599).
 *
 * The app frame is an in-page `<iframe>` in the MAIN WINDOW, so it shares the
 * window's session (`session.defaultSession`) and Electron never creates a
 * WebContents for it. Until this policy existed, the only permission denial
 * was the frame's `allow` attribute plus the shell's `Permissions-Policy`
 * header — which cover Permissions-Policy features ONLY. `notifications`, for
 * one, is not a Permissions-Policy feature: with no session handler installed,
 * Electron's default GRANTS every permission request, so
 * `Notification.requestPermission()` from the opaque app document resolved
 * `granted` (measured on the pinned Electron 43). This module closes that.
 *
 * How Electron attributes the requesting frame (measured on Electron 43.4.0):
 * - `setPermissionRequestHandler` receives `details.requestingUrl` = the
 *   requesting frame's last committed URL: `brainstrike-mcp-app://<token>/`
 *   for the shell frame and `about:srcdoc` for the app document. There is NO
 *   origin field and no frame handle. The field is REQUIRED on this handler.
 * - `setPermissionCheckHandler` receives the same `details.requestingUrl`
 *   (plus `requestingOrigin`, which is EMPTY for the opaque app document, and
 *   `embeddingOrigin`, which is the TOP frame's origin — neither discriminates
 *   the app frame). Here the field is OPTIONAL: Electron documents it as "not
 *   provided for cross-origin sub frames making permission checks", and the
 *   app document is precisely a cross-origin (opaque) sub frame. So the ONE
 *   handler whose attribution can go missing is also the one APIs consult
 *   first — anything that checks before requesting never reaches the request
 *   handler at all. An unattributable SUB frame check therefore fails CLOSED
 *   whenever the requesting WebContents hosts a sandbox frame, mirroring the
 *   `about:srcdoc` arm. A main-frame check is never the sandbox and keeps
 *   Electron's default.
 * - So the app document can only be recognized as "an `about:srcdoc` frame
 *   whose parent is a sandbox shell", resolved from the requesting
 *   WebContents' frame tree. The host renderer's frames are never
 *   `about:srcdoc`, never carry a shell scheme, and its main frame always
 *   reports `isMainFrame`, so the predicate is structurally incapable of
 *   denying the host renderer, and it denies nothing at all while no shell is
 *   mounted.
 * - `will-download` reports no frame at all — only the session, the item and
 *   the WebContents. A blob minted inside a frame carries that frame's origin
 *   in its URL (`blob:brainstrike-mcp-app://<token>/<uuid>` for the shell;
 *   `blob:file:///<uuid>` for the packaged host renderer), so the download arm
 *   keys on the shell origin appearing in the item's URL chain. The app
 *   document itself cannot start a download at all: its `sandbox` attribute is
 *   exactly `allow-scripts`, and without `allow-downloads` Chromium blocks the
 *   download before `will-download` fires (measured).
 *
 * WHICH sandboxes the permission arm covers: both opaque-origin
 * `sandbox="allow-scripts"` shells the main window can host — the MCP App
 * shell (`brainstrike-mcp-app:`) and the Canvas shell (`brainstrike-canvas:`,
 * BST-1173). Electron cannot say WHICH srcdoc frame asked, so covering only
 * one would make the other's posture depend on whether an MCP App happens to
 * be mounted; both host untrusted generated content and neither has any
 * legitimate use for a permission (every Permissions-Policy feature is already
 * denied by the frame's `allow` allowlist, so this arm's real subjects are the
 * NON-Permissions-Policy permissions — `notifications`, `openExternal` — which
 * neither sandbox may have).
 *
 * The DOWNLOAD arm stays MCP-App-only on purpose: the MCP App shell is a real
 * origin in an UNSANDBOXED iframe and can start a download, whereas the Canvas
 * shell is itself `sandbox="allow-scripts"` and Chromium blocks its downloads
 * before the session ever sees them.
 *
 * This policy is otherwise deliberately narrow. Every requester that is NOT a
 * sandbox frame keeps Electron's default outcome (granted / not cancelled), so
 * the host renderer and hidden renderer hosts are untouched. The browser pane
 * runs on its own partition with its own deny-by-default handlers
 * (`browser/browser-session.ts`) and is never reached from here.
 */

import { createLogger } from '@brainstrike/logging';
import { CANVAS_PROTOCOL_SCHEME } from '../canvas-protocol';
import { MCP_APP_SHELL_PROTOCOL_SCHEME } from './apps-shell-protocol';

const logger = createLogger('McpAppSessionPolicy');

const MCP_APP_SHELL_URL_PREFIX = `${MCP_APP_SHELL_PROTOCOL_SCHEME}://`;
const SHELL_BLOB_URL_PREFIX = `blob:${MCP_APP_SHELL_URL_PREFIX}`;
/** Every trusted shell that hosts an opaque-origin `about:srcdoc` sandbox. */
const SANDBOX_SHELL_URL_PREFIXES: readonly string[] = [
  MCP_APP_SHELL_URL_PREFIX,
  `${CANVAS_PROTOCOL_SCHEME}://`,
];
/** The URL Electron reports for a document that came from an `srcdoc` attribute. */
const SRCDOC_FRAME_URL = 'about:srcdoc';

/** One frame of the requesting WebContents, flattened for the predicate. */
export interface McpAppSessionFrame {
  /** The frame's parent's current URL, or `undefined` for the main frame. */
  readonly parentUrl: string | undefined;
  readonly url: string;
}

export interface McpAppPermissionRequester {
  /** Every live frame of the WebContents Electron attributed the request to. */
  readonly frames: readonly McpAppSessionFrame[];
  /** `details.isMainFrame`: present on BOTH handlers' details. */
  readonly isMainFrame: boolean;
  /**
   * `details.requestingUrl`: the requesting frame's last committed URL.
   * REQUIRED on the request handler, OPTIONAL on the check handler.
   */
  readonly requestingUrl: string | undefined;
}

function isSandboxShellUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  return SANDBOX_SHELL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Whether the requesting WebContents hosts an opaque sandbox document. */
function hostsSandboxFrame(frames: readonly McpAppSessionFrame[]): boolean {
  return frames.some(
    (frame) => frame.url === SRCDOC_FRAME_URL && isSandboxShellUrl(frame.parentUrl)
  );
}

/**
 * Whether a permission request/check came from an opaque-origin sandbox: a
 * sandbox shell frame itself, or the `about:srcdoc` document it hosts.
 *
 * The `about:srcdoc` and unattributable arms are fail-closed matches on the
 * frame tree: Electron cannot say WHICH srcdoc frame asked, so a window that
 * hosts a sandbox frame denies srcdoc and unattributable SUB-frame requesters.
 * The only srcdoc frames the main window can host are the MCP App and Canvas
 * sandboxes — never the host renderer.
 */
export function isSandboxedFramePermissionRequest(requester: McpAppPermissionRequester): boolean {
  const { isMainFrame, requestingUrl } = requester;
  if (requestingUrl === undefined || requestingUrl.length === 0) {
    // Electron omits `requestingUrl` for cross-origin sub-frame permission
    // CHECKS — which is exactly what an opaque sandbox document is. Fail
    // closed rather than grant an unattributable sub frame.
    return !isMainFrame && hostsSandboxFrame(requester.frames);
  }
  if (isSandboxShellUrl(requestingUrl)) {
    return true;
  }
  if (requestingUrl !== SRCDOC_FRAME_URL) {
    return false;
  }
  return hostsSandboxFrame(requester.frames);
}

/**
 * Whether a download was initiated from an MCP App shell origin — either a
 * direct `brainstrike-mcp-app:` URL or a `blob:` the shell frame minted, which
 * carries the shell origin in its URL.
 */
export function isMcpAppSandboxDownload(urlChain: readonly string[]): boolean {
  return urlChain.some(
    (url) => url.startsWith(MCP_APP_SHELL_URL_PREFIX) || url.startsWith(SHELL_BLOB_URL_PREFIX)
  );
}

function readFrameTree(webContents: Electron.WebContents | null): readonly McpAppSessionFrame[] {
  if (webContents === null || webContents.isDestroyed()) {
    return [];
  }
  const frames: McpAppSessionFrame[] = [];
  for (const frame of webContents.mainFrame.framesInSubtree) {
    if (!frame.isDestroyed()) {
      frames.push({
        parentUrl: frame.parent === null ? undefined : frame.parent.url,
        url: frame.url,
      });
    }
  }
  return frames;
}

let configuredSessions = new WeakSet<Electron.Session>();
/** Denial log keys already written, per requesting WebContents. */
let loggedDenials = new WeakMap<Electron.WebContents, Set<string>>();
/** Denial log keys for checks Electron could not attribute to a WebContents. */
let loggedDetachedDenials = new Set<string>();

/**
 * Record a denial ONCE per (WebContents, arm, permission).
 *
 * Both handlers are driven by untrusted content: a permission status read is
 * synchronous, needs no user gesture, and the sandbox document can issue it in
 * a tight loop, while a denial is silent to the page so nothing self-limits.
 * An unthrottled `warn` would therefore let untrusted content dictate the
 * write rate of the user's on-disk log. The permission name is a closed
 * Electron enum and there are two arms, so the key space is bounded at
 * ~O(permissions) lines per WebContents — the first occurrence of every
 * distinct denial is still recorded at `warn`, which is what made the denial
 * observable in the first place.
 */
function shouldLogDenial(webContents: Electron.WebContents | null, key: string): boolean {
  if (webContents === null) {
    if (loggedDetachedDenials.has(key)) {
      return false;
    }
    loggedDetachedDenials.add(key);
    return true;
  }
  let seen = loggedDenials.get(webContents);
  if (seen === undefined) {
    seen = new Set<string>();
    loggedDenials.set(webContents, seen);
  }
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

function logDenial(
  webContents: Electron.WebContents | null,
  arm: 'check' | 'request',
  permission: string,
  requestingUrl: string | undefined
): void {
  if (!shouldLogDenial(webContents, `${arm}|${permission}`)) {
    return;
  }
  logger.warn('Denied sandbox frame permission (repeats of this pair are not re-logged)', {
    arm,
    permission,
    requestingUrl,
  });
}

/**
 * Install the policy on a session. Idempotent per session: the permission
 * handlers are exclusive (a second call would replace them) and `will-download`
 * listeners would otherwise stack across window re-creation.
 */
export function installMcpAppSessionPolicy(target: Electron.Session): void {
  if (configuredSessions.has(target)) {
    return;
  }
  configuredSessions.add(target);

  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl;
    if (
      isSandboxedFramePermissionRequest({
        frames: readFrameTree(webContents),
        isMainFrame: details.isMainFrame,
        requestingUrl,
      })
    ) {
      logDenial(webContents, 'request', permission, requestingUrl);
      callback(false);
      return;
    }
    callback(true);
  });

  target.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl;
    if (
      isSandboxedFramePermissionRequest({
        frames: readFrameTree(webContents),
        isMainFrame: details.isMainFrame,
        requestingUrl,
      })
    ) {
      logDenial(webContents, 'check', permission, requestingUrl);
      return false;
    }
    return true;
  });

  target.on('will-download', (event, item) => {
    const url = item.getURL();
    if (!isMcpAppSandboxDownload([url, ...item.getURLChain()])) {
      return;
    }
    logger.warn('Cancelled MCP App sandbox download', { url });
    event.preventDefault();
  });

  logger.info('MCP App sandbox session policy installed');
}

/** Test-only reset of the per-session memos (the module is a singleton). */
export function __resetMcpAppSessionPolicyForTests(): void {
  configuredSessions = new WeakSet<Electron.Session>();
  loggedDenials = new WeakMap<Electron.WebContents, Set<string>>();
  loggedDetachedDenials = new Set<string>();
}
