import path from 'node:path';

const WATCHDOG_WORKER_FILE_NAME = 'main-watchdog-worker.js';

/** Resolve the emitted watchdog worker from a plain filesystem path. */
export function resolveMainWatchdogWorkerPath(
  appPath: string,
  isPackaged: boolean,
  currentModuleFilename: string = module.filename
): string {
  if (!isPackaged) {
    // BST-1459: app.getAppPath() changes with Electron's launch mode and can
    // already be dist/. The running CommonJS module reliably identifies the
    // emitted worker's sibling directory regardless of the entry argument.
    const moduleFilename =
      typeof currentModuleFilename === 'string' && currentModuleFilename.length > 0
        ? currentModuleFilename
        : path.join(process.cwd(), 'main.js');
    return path.join(path.dirname(moduleFilename), WATCHDOG_WORKER_FILE_NAME);
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `Main watchdog worker: Expected packaged app path to end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', WATCHDOG_WORKER_FILE_NAME);
}
