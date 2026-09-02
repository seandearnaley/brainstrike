import { MCP_APP_SHELL_PROTOCOL_SCHEME } from './apps-shell-protocol';

const SHELL_URL_PREFIX = `${MCP_APP_SHELL_PROTOCOL_SCHEME}://`;
const APP_FRAME_URL = 'about:srcdoc';

export interface McpAppFrameNavigation {
  /** The navigating frame's CURRENT (pre-navigation) URL. */
  readonly frameUrl: string;
  readonly isMainFrame: boolean;
  /** The navigating frame's parent's current URL, if it has a parent. */
  readonly parentUrl: string | undefined;
  /** Where the frame wants to go. */
  readonly targetUrl: string;
}

function isShellUrl(url: string | undefined): boolean {
  return url?.startsWith(SHELL_URL_PREFIX) === true;
}

/**
 * Subframe navigation fence for the MCP App sandbox in the main window
 * (BST-1572). Electron's `will-navigate` covers only the main frame, so this
 * predicate backs a `will-frame-navigate` listener:
 *
 * - the SHELL frame (current URL on `brainstrike-mcp-app:`) never navigates
 *   anywhere — it is served once and lives until the mount is released;
 * - the APP frame (its parent is the shell) may only ever load `about:srcdoc`,
 *   its initial sandboxed document; a self-navigation to any other URL
 *   (which `sandbox="allow-scripts"` alone does not stop) is denied.
 *
 * The initial `<iframe src="brainstrike-mcp-app://…">` load is a navigation
 * of a frame whose current URL is `about:blank` under the host document, and
 * frames the app itself embeds under `frameDomains` have the app frame as
 * their parent, so neither is touched. Main-frame navigations are left to
 * `will-navigate`.
 */
export function shouldDenyMcpAppFrameNavigation(navigation: McpAppFrameNavigation): boolean {
  if (navigation.isMainFrame) {
    return false;
  }
  if (isShellUrl(navigation.frameUrl)) {
    return true;
  }
  if (isShellUrl(navigation.parentUrl)) {
    return navigation.targetUrl !== APP_FRAME_URL;
  }
  return false;
}
