import path from 'node:path';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';

const WATCHDOG_WORKER_FILE_NAME = 'main-watchdog-worker.js';

/** Resolve the emitted watchdog worker from a plain filesystem path. */
export function resolveMainWatchdogWorkerPath(
  appPath: string,
  isPackaged: boolean,
  currentModuleFilename?: string
): string {
  if (!isPackaged) {
    // BST-1459: see bundled-sibling-path.ts for the full launch-mode
    // rationale and NO SILENT FALLBACKS reasoning (PR #2680 review).
    return resolveBundledSiblingPath(
      'Main watchdog worker',
      WATCHDOG_WORKER_FILE_NAME,
      currentModuleFilename
    );
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `Main watchdog worker: Expected packaged app path to end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', WATCHDOG_WORKER_FILE_NAME);
}
