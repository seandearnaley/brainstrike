import path from 'node:path';

const WATCHDOG_WORKER_FILE_NAME = 'main-watchdog-worker.js';

/** Resolve the emitted watchdog worker from a plain filesystem path. */
export function resolveMainWatchdogWorkerPath(
  appPath: string,
  isPackaged: boolean,
  mainModulePath: string
): string {
  if (!isPackaged) {
    const mainOutputDir = path.dirname(mainModulePath);
    if (path.basename(mainModulePath) !== 'main.js' || path.basename(mainOutputDir) !== 'dist') {
      throw new Error(
        `Main watchdog worker: Expected development main entry to be dist/main.js, received "${mainModulePath}"`
      );
    }
    return path.join(mainOutputDir, WATCHDOG_WORKER_FILE_NAME);
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `Main watchdog worker: Expected packaged app path to end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', WATCHDOG_WORKER_FILE_NAME);
}
