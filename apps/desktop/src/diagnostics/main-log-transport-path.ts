import path from 'node:path';

const TRANSPORT_FILE_NAME = 'main-log-transport.js';

/**
 * Resolve the Pino worker from a plain filesystem path in packaged builds.
 * Electron Builder places the explicitly-unpacked entry beside app.asar.
 */
export function resolveMainLogTransportPath(
  appPath: string,
  isPackaged: boolean,
  currentModuleFilename: string = module.filename
): string {
  if (!isPackaged) {
    // BST-1459: app.getAppPath() changes with Electron's launch mode and can
    // already be dist/ (e.g. Playwright's e2e harness launches Electron with
    // a direct path to dist/main.js, which has no package.json above it, so
    // app.getAppPath() returns dist/ itself and appending 'dist' here would
    // double it — the same bug fixed for main-watchdog-path.ts). This never
    // surfaced as a visible failure in e2e because BRAINSTRIKE_DISABLE_FILE_LOGS=1
    // short-circuits main.ts's getLogFilePath() before this path is ever
    // dereferenced by a pino transport worker — masked, not absent. The
    // running CommonJS module reliably identifies the emitted worker's
    // sibling directory regardless of the entry argument.
    const moduleFilename =
      typeof currentModuleFilename === 'string' && currentModuleFilename.length > 0
        ? currentModuleFilename
        : path.join(process.cwd(), 'main.js');
    return path.join(path.dirname(moduleFilename), TRANSPORT_FILE_NAME);
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `main log transport: packaged app path must end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', TRANSPORT_FILE_NAME);
}
