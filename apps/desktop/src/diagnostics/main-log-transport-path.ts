import path from 'node:path';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';

const TRANSPORT_FILE_NAME = 'main-log-transport.js';

/**
 * Resolve the Pino worker from a plain filesystem path in packaged builds.
 * Electron Builder places the explicitly-unpacked entry beside app.asar.
 */
export function resolveMainLogTransportPath(
  appPath: string,
  isPackaged: boolean,
  currentModuleFilename?: string
): string {
  if (!isPackaged) {
    // BST-1459: see bundled-sibling-path.ts for the full launch-mode
    // rationale and NO SILENT FALLBACKS reasoning (PR #2680 review). This
    // never surfaced as a visible failure in e2e because
    // BRAINSTRIKE_DISABLE_FILE_LOGS=1 short-circuits main.ts's
    // getLogFilePath() before this path is ever dereferenced by a pino
    // transport worker — masked, not absent.
    return resolveBundledSiblingPath(
      'main log transport',
      TRANSPORT_FILE_NAME,
      currentModuleFilename
    );
  }
  if (path.basename(appPath) !== 'app.asar') {
    throw new Error(
      `main log transport: packaged app path must end in app.asar, received "${appPath}"`
    );
  }
  return path.join(path.dirname(appPath), 'app.asar.unpacked', 'dist', TRANSPORT_FILE_NAME);
}
