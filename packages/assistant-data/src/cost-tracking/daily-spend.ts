/**
 * Derived last-24h spend. `totalUsd = exactUsd + estimatedUsd`; tokens from
 * models WITHOUT a registry list price are EXCLUDED from the total and the
 * models are named in `unpricedModels` (as `provider::model`) so the UI can
 * render an explicit "+N unpriced" marker — never a fabricated price.
 */
export interface DailySpendSummary {
  readonly estimatedUsd: number;
  readonly exactUsd: number;
  readonly totalUsd: number;
  readonly unpricedModels: readonly string[];
}

/** One provider call an agent-host thread committed, as the spend views count it. */
export interface HostUsageRecord {
  /** The committed row time (ms since epoch). */
  readonly at: number;
  /** What the provider billed for the call; absent when it reported no amount. */
  readonly billedCostUsd?: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** The call's list price at its own request's tier; null when its model is unpriced. */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
}

const DAILY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The rolling last-24h window (UI copy says "last 24h", never "today") over
 * the host's committed calls. A billed call counts what its provider billed;
 * any other call is a registry estimate, and an unpriceable model is excluded
 * from the total but named — the guardrail must never gate, or decline to
 * gate, on a fabricated number.
 */
export function resolveHostDailySpend(
  records: readonly HostUsageRecord[],
  nowMs: number
): DailySpendSummary {
  let exactUsd = 0;
  let estimatedUsd = 0;
  const unpricedModels = new Set<string>();
  for (const record of records) {
    if (record.at < nowMs - DAILY_SPEND_WINDOW_MS) {
      continue;
    }
    if (record.billedCostUsd !== undefined) {
      exactUsd += record.billedCostUsd;
    } else if (record.costUsd === null) {
      unpricedModels.add(`${record.provider}::${record.model}`);
    } else {
      estimatedUsd += record.costUsd;
    }
  }
  return {
    estimatedUsd,
    exactUsd,
    totalUsd: exactUsd + estimatedUsd,
    unpricedModels: [...unpricedModels].sort(),
  };
}
