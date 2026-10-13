import { createLogger } from '@brainstrike/logging';
import { powerSaveBlocker } from 'electron';

const logger = createLogger('EmbeddingHostManager');

function isPowerSaveBlockerStillActive(blockerId: number): boolean {
  try {
    return powerSaveBlocker.isStarted(blockerId);
  } catch {
    // The recheck itself failing means the id is unusable either way;
    // treat it as stale so the manager cannot wedge.
    return false;
  }
}

/**
 * Stops an idle embedding host's power-save blocker. Returns the id to keep: null once
 * stopped or stale, the same id when a failed stop left the blocker verifiably active,
 * so the next stop retries it and no duplicate blocker starts.
 */
export function stopEmbeddingHostPowerSaveBlocker(
  blockerId: number,
  runtimeId: string
): number | null {
  try {
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
      logger.info('powerSaveBlocker stopped for idle embedding host', {
        id: blockerId,
        runtimeId,
      });
    }
    return null;
  } catch (stopError) {
    if (isPowerSaveBlockerStillActive(blockerId)) {
      logger.warn('powerSaveBlocker stop failed; blocker still active, keeping id to retry', {
        error: stopError,
        id: blockerId,
        runtimeId,
      });
      return blockerId;
    }
    // Clear stale ids so the manager can start a new blocker.
    logger.warn('powerSaveBlocker stop failed; clearing stale blocker id', {
      error: stopError,
      id: blockerId,
      runtimeId,
    });
    return null;
  }
}
