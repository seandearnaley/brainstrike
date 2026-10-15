import { resolve } from 'node:path';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../../desktop-renderer-target';
import {
  type DesktopIpcSenderFrameAllowlist,
  resolveDesktopIpcSenderFrameAllowlist,
} from '../../platform/desktop-ipc-sender-frame';
import type { DesktopWindowRole } from '../../window-role';

/**
 * Deterministic renderer target + sender-frame allowlist for the desktop unit
 * lane (BST-1641). Matches the electron test harness's
 * `app.getAppPath() === resolve('/mock/app')` so a production-shaped
 * `dist/renderer/index.html` URL is the trusted document — and so a suite that
 * boots `main.ts` under that mock configures an equal target.
 * `src/__tests__/setup.ts` installs the target process-wide before every
 * file; tests that need a different allowlist inject one into
 * `createDesktopIpcRegistry` or configure a different target explicitly.
 * This module deliberately imports no window-role RUNTIME so suites that mock
 * `window-role` can still build allowlisted frames.
 */
const TEST_BUILT_RENDERER_PATH = resolve('/mock/app/dist/renderer/index.html');
export const TEST_DESKTOP_RENDERER_TARGET = createDesktopRendererTarget({
  builtRendererPath: TEST_BUILT_RENDERER_PATH,
  devRendererUrl: 'http://localhost:38181',
  launchMode: 'built',
});

function allowlistedDocumentUrl(allowlist: DesktopIpcSenderFrameAllowlist): string {
  if (allowlist.kind === 'built-renderer') {
    return allowlist.documentUrl;
  }
  return `${allowlist.origin}${allowlist.pathname}`;
}

/**
 * A `senderFrame` stand-in whose URL is on `allowlist`. By default that is the
 * allowlist derived from the renderer target configured on THIS module
 * instance's `desktop-renderer-target` (read at call time) — normally the
 * pinned test target from `setup.ts`, or whatever a suite that boots
 * `main.ts` under a partial electron mock configured from that mock's
 * `app.getAppPath()`. That default is correct exactly when the registry under
 * test shares this module instance, which is always the case EXCEPT after
 * `vi.resetModules()`: the registry then consumes a fresh, unconfigured
 * instance, and `reconfigureTestRendererTargetAfterModuleReset` pins BOTH
 * instances to the test target so the two agree again. A suite that
 * configures a DIFFERENT target on a fresh instance must pass `allowlist`
 * explicitly. Hidden roles carry the `?mode=` query the real hosts load with.
 * Throws (fail-closed) when nothing is configured, exactly like the registry.
 */
export function createAllowlistedSenderFrame(
  role: DesktopWindowRole = 'visible-ui',
  allowlist: DesktopIpcSenderFrameAllowlist = resolveDesktopIpcSenderFrameAllowlist()
): Pick<Electron.WebFrameMain, 'url'> {
  const documentUrl = allowlistedDocumentUrl(allowlist);
  const url =
    role === 'visible-ui' ? documentUrl : `${documentUrl}?mode=${role}&runtimeId=test-runtime`;
  return { url };
}

/**
 * `vi.resetModules()` gives the next registry import a FRESH renderer-target
 * module with nothing configured, so every authorized invoke fails closed
 * with "Desktop renderer target is not configured". Suites that reset modules
 * call this right after the reset: it installs the pinned test target on that
 * fresh instance (a dynamic import resolves the post-reset module) AND on the
 * instance this helper statically imported, so `createAllowlistedSenderFrame`
 * and the fresh registry cannot disagree.
 */
export async function reconfigureTestRendererTargetAfterModuleReset(): Promise<void> {
  const fresh = await import('../../desktop-renderer-target');
  fresh.configureDesktopRendererTarget(TEST_DESKTOP_RENDERER_TARGET);
  configureDesktopRendererTarget(TEST_DESKTOP_RENDERER_TARGET);
}
