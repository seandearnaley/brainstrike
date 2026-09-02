/**
 * Session-level permission and download policy for the MCP App sandbox
 * (BST-1599).
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
 *   origin field and no frame handle.
 * - `setPermissionCheckHandler` receives the same `details.requestingUrl`
 *   (plus `requestingOrigin`, which is EMPTY for the opaque app document, and
 *   `embeddingOrigin`, which is the TOP frame's origin — neither discriminates
 *   the app frame).
 * - So the app document can only be recognized as "an `about:srcdoc` frame
 *   whose parent is a shell", resolved from the requesting WebContents' frame
 *   tree. The host renderer's frames are never `about:srcdoc` and never carry
 *   the shell scheme, so the predicate is structurally incapable of denying
 *   the host renderer, and it denies nothing at all while no shell is mounted.
 * - `will-download` reports no frame at all — only the session, the item and
 *   the WebContents. A blob minted inside a frame carries that frame's origin
 *   in its URL (`blob:brainstrike-mcp-app://<token>/<uuid>` for the shell;
 *   `blob:file:///<uuid>` for the packaged host renderer), so the download arm
 *   keys on the shell origin appearing in the item's URL chain. The app
 *   document itself cannot start a download at all: its `sandbox` attribute is
 *   exactly `allow-scripts`, and without `allow-downloads` Chromium blocks the
 *   download before `will-download` fires (measured).
 *
 * This policy is deliberately narrow. Every requester that is NOT an MCP App
 * sandbox frame keeps Electron's default outcome (granted / not cancelled), so
 * the host renderer and hidden renderer hosts are untouched. The browser pane
 * runs on its own partition with its own deny-by-default handlers
 * (`browser/browser-session.ts`) and is never reached from here.
 */

import { createLogger } from '@brainstrike/logging';
import { MCP_APP_SHELL_PROTOCOL_SCHEME } from './apps-shell-protocol';

const logger = createLogger('McpAppSessionPolicy');

const SHELL_URL_PREFIX = `${MCP_APP_SHELL_PROTOCOL_SCHEME}://`;
const SHELL_BLOB_URL_PREFIX = `blob:${SHELL_URL_PREFIX}`;
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
  /** `details.requestingUrl`: the requesting frame's last committed URL. */
  readonly requestingUrl: string | undefined;
}

function isShellUrl(url: string | undefined): boolean {
  return url?.startsWith(SHELL_URL_PREFIX) === true;
}

/**
 * Whether a permission request/check came from the MCP App sandbox: the shell
 * frame itself, or the opaque `about:srcdoc` app document it hosts.
 *
 * The `about:srcdoc` arm is a fail-closed match on the frame tree: Electron
 * cannot say WHICH srcdoc frame asked, so a window that hosts an MCP App frame
 * denies srcdoc requesters. The only other srcdoc frame the main window can
 * host is the Canvas sandbox — an equally untrusted opaque-origin
 * `allow-scripts` frame — never the host renderer.
 */
export function isMcpAppSandboxPermissionRequest(requester: McpAppPermissionRequester): boolean {
  const { requestingUrl } = requester;
  if (requestingUrl === undefined || requestingUrl.length === 0) {
    return false;
  }
  if (isShellUrl(requestingUrl)) {
    return true;
  }
  if (requestingUrl !== SRCDOC_FRAME_URL) {
    return false;
  }
  return requester.frames.some(
    (frame) => frame.url === SRCDOC_FRAME_URL && isShellUrl(frame.parentUrl)
  );
}

/**
 * Whether a download was initiated from an MCP App shell origin — either a
 * direct `brainstrike-mcp-app:` URL or a `blob:` the shell frame minted, which
 * carries the shell origin in its URL.
 */
export function isMcpAppSandboxDownload(urlChain: readonly string[]): boolean {
  return urlChain.some(
    (url) => url.startsWith(SHELL_URL_PREFIX) || url.startsWith(SHELL_BLOB_URL_PREFIX)
  );
}

function readFrameTree(webContents: Electron.WebContents | null): readonly McpAppSessionFrame[] {
  if (webContents === null || webContents.isDestroyed()) {
    return [];
  }
  return webContents.mainFrame.framesInSubtree
    .filter((frame) => !frame.isDestroyed())
    .map((frame) => ({
      parentUrl: frame.parent === null ? undefined : frame.parent.url,
      url: frame.url,
    }));
}

let configuredSessions = new WeakSet<Electron.Session>();

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
    if (isMcpAppSandboxPermissionRequest({ frames: readFrameTree(webContents), requestingUrl })) {
      logger.warn('Denied MCP App sandbox permission request', { permission, requestingUrl });
      callback(false);
      return;
    }
    callback(true);
  });

  target.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl;
    if (isMcpAppSandboxPermissionRequest({ frames: readFrameTree(webContents), requestingUrl })) {
      logger.warn('Denied MCP App sandbox permission check', { permission, requestingUrl });
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

/** Test-only reset of the per-session memo (the module is a singleton). */
export function __resetMcpAppSessionPolicyForTests(): void {
  configuredSessions = new WeakSet<Electron.Session>();
}
