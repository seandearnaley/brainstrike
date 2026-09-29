import path from 'node:path';
import { app } from 'electron';

/**
 * Absolute path of the `dist/` directory the running main process ships in.
 * `app.getAppPath()` is launch-mode-dependent: it is the project root under
 * `electron .` but `dist/` itself when Electron is launched with a direct
 * path to `dist/main.js` (Playwright's desktop e2e harness). Every consumer
 * that loads a document or preload from `dist/` — the visible window, the
 * hidden renderer hosts, and the IPC sender-frame allowlist that must agree
 * with them — resolves through this one function so they cannot drift.
 */
export function resolveDistRoot(): string {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
}

/** `dist/renderer/index.html` — the single renderer document every window loads. */
export function resolveBuiltRendererPath(): string {
  return path.join(resolveDistRoot(), 'renderer', 'index.html');
}
