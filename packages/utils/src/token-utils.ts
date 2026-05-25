/**
 * Utility functions for estimating token counts for large language models.
 *
 * Accurate tiktoken runtime logic is owned by
 * @brainstrike/text-splitter/token-utils-accurate-lite so worker and utility
 * call paths cannot drift independently.
 */
import {
  countTokensAccurate as countTokensAccurateStrict,
  supportsAccurateTokenCounting as supportsAccurateTokenCountingStrict,
} from '@brainstrike/text-splitter/token-utils-accurate-lite';
import { createLogger } from '@brainstrike/utils/logger';

export {
  ACCURATE_TOKEN_ENCODING,
  ACCURATE_TOKEN_MODEL_HINT,
} from '@brainstrike/text-splitter/token-constants';
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

/**
 * Calculate token count for a group of texts
 *
 * @param texts - Array of text strings
 * @param useHeuristic - Whether to use the faster heuristic method
 * @returns Total token count for all texts
 */
export async function calculateGroupTokens(texts: string[]): Promise<number> {
  if (texts.length === 0) {
    return 0;
  }

  let total = 0;
  let lastYield = performance.now();
  const YieldThresholdMs = 5;
  const textCount = texts.length;

  for (let i = 0; i < textCount; i++) {
    const text = texts[i];
    if (text) {
      total += await countTokensAccurate(text);
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
  return total;
}
