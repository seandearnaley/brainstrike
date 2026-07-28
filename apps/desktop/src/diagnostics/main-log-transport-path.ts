import path from 'node:path';

const TRANSPORT_FILE_NAME = 'main-log-transport.js';

/**
 * Resolve the Pino worker from a plain filesystem path in packaged builds.
 * Electron Builder places the explicitly-unpacked entry beside app.asar.
 */
export function resolveMainLogTransportPath(appPath: string, isPackaged: boolean): string {
  if (!isPackaged) {
    return path.join(appPath, 'dist', TRANSPORT_FILE_NAME);
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `main log transport: packaged app path must end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', TRANSPORT_FILE_NAME);
}
