import path from 'node:path';

const WATCHDOG_WORKER_FILE_NAME = 'main-watchdog-worker.js';

/** Resolve the emitted watchdog worker from a plain filesystem path. */
export function resolveMainWatchdogWorkerPath(appPath: string, isPackaged: boolean): string {
  if (!isPackaged) {
    return path.join(appPath, 'dist', WATCHDOG_WORKER_FILE_NAME);
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `Main watchdog worker: Expected packaged app path to end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', WATCHDOG_WORKER_FILE_NAME);
}
