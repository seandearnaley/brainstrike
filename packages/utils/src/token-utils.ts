/**
 * Utility functions for estimating token counts for large language models.
 *
 * Accurate tiktoken runtime logic is owned by ./token-utils-accurate-lite so
 * worker and utility call paths cannot drift independently.
 */

import { createLogger } from '@brainstrike/utils/logger';
import {
  countTokensAccurate as countTokensAccurateStrict,
  getAccurateTokenCounter,
  type SyncAccurateCounter,
  supportsAccurateTokenCounting as supportsAccurateTokenCountingStrict,
} from './token-utils-accurate-lite';

export {
  ACCURATE_TOKEN_ENCODING,
  ACCURATE_TOKEN_MODEL_HINT,
} from './token-constants';
export {
  countTokensHeuristic,
  estimateTokenCost,
  formatTokenCount,
} from './token-counting-heuristics';

import { countTokensHeuristic } from './token-counting-heuristics';

let loadFailureLogged = false;
const logger = createLogger('TokenUtils');

function logTiktokenFailure(message: string, error: unknown): void {
  if (loadFailureLogged) {
    return;
  }
  loadFailureLogged = true;
  logger.warn(message, { error });
}

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  try {
    return await supportsAccurateTokenCountingStrict();
  } catch (error) {
    logTiktokenFailure('Failed to check tiktoken support; falling back to heuristic', error);
    return false;
  }
}

/**
 * Accurately count tokens using the wasm-backed tiktoken bindings. Falls back to heuristic estimation when the
 * bindings are unavailable (e.g., unsupported runtime or transient load failure).
 */
export async function countTokensAccurate(text: string): Promise<number> {
  if (!text) {
    return 0;
  }

  try {
    return await countTokensAccurateStrict(text);
  } catch (error) {
    logTiktokenFailure('tiktoken count failed; falling back to heuristic', error);
    return countTokensHeuristic(text);
  }
}

interface BatchFaultState {
  count: number;
  firstError: unknown;
  lastError: unknown;
}

// Wraps sync counter with per-item fault tolerance, degrading to heuristic.
function countItem(
  text: string,
  counter: SyncAccurateCounter | null,
  faultState: BatchFaultState
): number {
  if (!counter) {
    return countTokensHeuristic(text);
  }
  try {
    return counter(text);
  } catch (error) {
    if (faultState.count === 0) {
      faultState.firstError = error;
    }
    faultState.lastError = error;
    faultState.count += 1;
    return countTokensHeuristic(text);
  }
}

async function resolveBatchCounter(): Promise<SyncAccurateCounter | null> {
  try {
    return await getAccurateTokenCounter();
  } catch (error) {
    logTiktokenFailure('tiktoken batch resolve failed; falling back to heuristic', error);
    return null;
  }
}

/**
 * Calculate the total token count for a batch of texts.
 *
 * Resolves the tiktoken encoder once at the top of the batch; availability
 * is all-or-nothing (the entire batch uses accurate counts or the entire
 * batch uses the heuristic). Per-item encoding faults degrade gracefully
 * to heuristic for the affected item only.
 *
 * @param texts - Array of text strings
 * @returns Total token count for all texts
 */
export async function calculateGroupTokens(texts: string[]): Promise<number> {
  if (texts.length === 0) {
    return 0;
  }

  const counter = await resolveBatchCounter();
  // Track per-item faults locally; batch-end summary bypasses the once-only gate.
  const faultState: BatchFaultState = {
    count: 0,
    firstError: undefined,
    lastError: undefined,
  };
  let total = 0;
  let lastYield = performance.now();
  const YieldThresholdMs = 5;
  const textCount = texts.length;

  for (let i = 0; i < textCount; i++) {
    const text = texts[i];
    if (text) {
      total += countItem(text, counter, faultState);
    }

    // Yield every 20 items if time threshold exceeded to avoid blocking the event loop.
    if (i % 20 === 0) {
      const now = performance.now();
      if (now - lastYield > YieldThresholdMs) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  }

  // Always log when any item degraded. Bypasses logTiktokenFailure's
  // module-level once-only flag, so operators see error detail per batch
  // (not per module lifetime) — important for diagnosing encoding faults
  // that change shape over time.
  if (faultState.count > 0) {
    logger.warn('tiktoken per-item encode failures degraded to heuristic in batch', {
      faultCount: faultState.count,
      batchSize: textCount,
      firstError: faultState.firstError,
      lastError: faultState.lastError,
    });
  }
  return total;
}
