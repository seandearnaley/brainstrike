import { countEstimatedTokens } from '@brainstrike/utils/token-counting-heuristics';
import type { TokenCountingMode } from './types';

export interface AccurateTokenUtils {
  countTokensAccurate: (text: string) => Promise<number>;
  getAccurateTokenCountingFailureReason: () => string | null;
  supportsAccurateTokenCounting: () => Promise<boolean>;
}

function buildAccurateCountingUnavailableError(failureReason: string | null): Error {
  const failureSuffix = failureReason ? ` (${failureReason})` : '';
  return new Error(
    `Accurate token counting unavailable: tiktoken encoder failed to initialize${failureSuffix}`
  );
}

export async function assertAccurateCountingAvailable(
  loadAccurateTokenUtils: () => Promise<AccurateTokenUtils>
): Promise<AccurateTokenUtils> {
  const accurateUtils = await loadAccurateTokenUtils();
  const accurateSupported = await accurateUtils.supportsAccurateTokenCounting();
  if (!accurateSupported) {
    throw buildAccurateCountingUnavailableError(
      accurateUtils.getAccurateTokenCountingFailureReason()
    );
  }

  return accurateUtils;
}

export async function countTokensForMode(
  _mode: TokenCountingMode,
  text: string,
  _loadAccurateTokenUtils: () => Promise<AccurateTokenUtils>
): Promise<number> {
  return countEstimatedTokens(text);
}
