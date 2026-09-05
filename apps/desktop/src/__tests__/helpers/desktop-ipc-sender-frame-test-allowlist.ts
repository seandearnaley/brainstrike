import { pathToFileURL } from 'node:url';
import {
  createDesktopIpcSenderFrameAllowlist,
  type DesktopIpcSenderFrameAllowlist,
  resolveDesktopIpcSenderFrameAllowlist,
} from '../../platform/desktop-ipc-sender-frame';
import type { DesktopWindowRole } from '../../window-role';

/**
 * Deterministic sender-frame allowlist for the desktop unit lane (BST-1641).
 * Matches the electron test harness's `app.getAppPath() === '/mock/app'` so a
 * production-shaped `dist/renderer/index.html` URL is the trusted document.
 * `src/__tests__/setup.ts` installs it process-wide before every file; tests
 * that need a different allowlist inject one into `createDesktopIpcRegistry`.
 * This module deliberately imports no window-role RUNTIME so suites that mock
 * `window-role` can still build allowlisted frames.
 */
const TEST_BUILT_RENDERER_PATH = '/mock/app/dist/renderer/index.html';
export const TEST_DESKTOP_IPC_SENDER_FRAME_ALLOWLIST = createDesktopIpcSenderFrameAllowlist({
  builtRendererPath: TEST_BUILT_RENDERER_PATH,
  devRendererUrl: 'http://localhost:38181',
  launchMode: 'built',
});

function allowlistedDocumentUrl(allowlist: DesktopIpcSenderFrameAllowlist): string {
  if (allowlist.kind === 'built-renderer') {
    return pathToFileURL(allowlist.rendererPath).href;
  }
  return `${allowlist.origin}${allowlist.pathname}`;
}

/**
 * A `senderFrame` stand-in whose URL is on the allowlist CURRENTLY configured
 * process-wide — normally the test allowlist above, but a suite that boots
 * `main.ts` under a partial electron mock reconfigures it from that mock's
 * `app.getAppPath()`, and the frame must follow. Hidden roles carry the
 * `?mode=` query the real hosts load with. Throws (fail-closed) when nothing
 * is configured, exactly like the registry would.
 */
export function createAllowlistedSenderFrame(
  role: DesktopWindowRole = 'visible-ui'
): Pick<Electron.WebFrameMain, 'url'> {
  const documentUrl = allowlistedDocumentUrl(resolveDesktopIpcSenderFrameAllowlist());
  const url =
    role === 'visible-ui' ? documentUrl : `${documentUrl}?mode=${role}&runtimeId=test-runtime`;
  return { url };
}

/**
 * `vi.resetModules()` gives the next registry import a FRESH sender-frame
 * module whose process-wide allowlist is unconfigured, so every authorized
 * invoke fails closed with "allowlist is not configured". Suites that reset
 * modules call this right after the reset to reinstall the test allowlist on
 * that fresh instance (a dynamic import resolves the post-reset module).
 */
export async function reconfigureTestSenderFrameAllowlistAfterModuleReset(): Promise<void> {
  const fresh = await import('../../platform/desktop-ipc-sender-frame');
  fresh.configureDesktopIpcSenderFrameAllowlist(TEST_DESKTOP_IPC_SENDER_FRAME_ALLOWLIST);
}
