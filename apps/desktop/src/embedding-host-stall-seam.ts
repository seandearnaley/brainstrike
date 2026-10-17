import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const logger = createLogger('EmbeddingHostManager');

/**
 * E2E fault seam (BST-2104): Main withholds the first N document batches from the embedding host,
 * so the real liveness window expires exactly as it does for a host that hangs. Read only in an
 * unpackaged test-mode launch; a shipped build never reads the variable.
 */
export const EMBEDDING_HOST_STALL_SEAM_ENV = 'BRAINSTRIKE_E2E_STALL_EMBEDDING_DOCUMENT_BATCHES';

/** Returns whether the next document batch is withheld, and logs each one it withholds. */
export function createEmbeddingHostStallSeam(
  env: Readonly<Record<string, string | undefined>> = process.env,
  enabled: () => boolean = () => isElectronE2ETestMode() && !app.isPackaged
): (requestId: string) => boolean {
  const raw = env[EMBEDDING_HOST_STALL_SEAM_ENV];
  if (raw === undefined || !enabled()) {
    return () => false;
  }
  let remaining = Number(raw);
  if (!(Number.isSafeInteger(remaining) && remaining > 0)) {
    throw new Error(`${EMBEDDING_HOST_STALL_SEAM_ENV} must be a positive integer.`);
  }
  return (requestId) => {
    if (remaining === 0) {
      return false;
    }
    remaining -= 1;
    logger.warn('E2E stall seam withheld a document batch from the embedding host', {
      remaining,
      requestId,
    });
    return true;
  };
}
