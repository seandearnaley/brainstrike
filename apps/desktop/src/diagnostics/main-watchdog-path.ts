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
    // Inherited from db-host-manager.ts's resolveDefaultEntryPath(), not
    // independently justified here: `module.filename` is set synchronously
    // by CJS module init before this function can ever run, so this branch
    // is unreachable in practice, and it would resolve to the wrong
    // directory (silently) if it were ever hit. Don't treat it as real
    // protection — it's a vestigial shape carried over, not a tested seam.
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
