import {
  getProviderDisplayName,
  isSupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { resolveModelLabel } from '@brainstrike/assistant-contract/provider-registry';
import { formatUsdCost } from '@brainstrike/tokenization';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return '—';
  }
  if (durationMs < MS_PER_SECOND) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainder = Math.round(seconds % SECONDS_PER_MINUTE);
  return `${minutes}m ${remainder}s`;
}

export function formatTokensCompact(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Dollars for a ledger: cents from a cent up, two significant digits below it
 * so a real sub-cent cost stays visible without a wall of decimals.
 */
export function formatUsd(amount: number): string {
  if (amount === 0 || Math.abs(amount) >= 0.01) {
    return formatUsdCost(amount);
  }
  return `$${Number(amount.toPrecision(2))}`;
}

/** A cost with its honest qualifier: a total that left unpriced runs out says so. */
export function formatEstimatedCost(costUsd: number, unpricedCount: number): string {
  if (unpricedCount === 0) {
    return formatUsd(costUsd);
  }
  return costUsd === 0 ? 'unavailable' : `${formatUsd(costUsd)}+`;
}

/** A catalogued model's own name and its provider's, else the raw id. */
export function modelDisplayName(
  provider: string,
  model: string
): { readonly model: string; readonly provider: string } {
  return {
    model: resolveModelLabel(provider, model),
    provider: isSupportedProvider(provider) ? getProviderDisplayName(provider) : provider,
  };
}

/** The share of `part` in `total` as a CSS width, never NaN. */
export function shareWidth(part: number, total: number): string {
  return total > 0 ? `${Math.max(0, Math.min(100, (part / total) * 100))}%` : '0%';
}
