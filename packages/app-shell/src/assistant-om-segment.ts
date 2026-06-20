/**
 * Observational-memory (OM) informational stats derivation for the context meter.
 *
 * IMPORTANT — the OM observation is NOT a slice of this turn's input budget.
 * An earlier "tri-segment" model (chat + observation + free vs ONE
 * effectiveInputBudget) was arithmetically incoherent and was removed:
 *   - With the default `retrievalMode: 'off'`, the observation is NOT injected
 *     into the prompt (packages/agent/src/pglite-mastra-memory/memory-factory.ts
 *     only wires `retrieval` for 'messages'/'vector'), so observationTokenCount
 *     does NOT consume the input budget — painting it as a budget segment is false.
 *   - When retrieval IS on, the injected observation is ALREADY counted inside the
 *     last turn's inputTokens (= the meter's chat usage), so chat + observation
 *     would DOUBLE-COUNT it and could trip a false "over budget".
 * So the observation is INFORMATIONAL — "what OM is holding for this thread" —
 * surfaced as two stats next to the (unchanged) chat-vs-budget bar:
 *   1. OM context: ~Nk tokens observed   (observationTokenCount)
 *   2. Reflection saved ~Nk tokens        (totalTokensObserved − observationTokenCount)
 * The resolver therefore takes NO budget/chat input — it structurally CANNOT feed
 * the budget math.
 *
 * The two token columns are read RAW off `mastra_observational_memory` (see
 * use-om-segment-row.ts + the projection drift guard in
 * packages/db/__tests__/mastra-om-schema-projection.test.ts). This module is the
 * PURE derivation: row + flags → a discriminated OmMeterState, unit-testable
 * without a DB or React.
 *
 * No-silent-fallbacks contract (the bots flagged this exact pattern on 5.1/5.2):
 *   - web (no durable capability) → 'chat-only' (OM stats hidden) — NOT zeros.
 *   - OM disabled                 → 'inactive'  (explicit) — NOT "0 saved".
 *   - loading (initial / thread switch) → 'loading' — keeps the OM stats quiet,
 *     never flashes the honest-empty state before the row arrives.
 *   - no OM row yet               → 'empty'     — NOT a throw, NOT zeros.
 *   - malformed OM row            → 'error'     (strict parser throws, caught here) — NEVER fabricated 0.
 */
import type { OmMeterState } from '@brainstrike/ui/assistant-ui-panel';
import { getErrorMessage } from '@brainstrike/utils/error-utils';

export type { OmMeterState };

/** The exact RAW columns the meter reads off `mastra_observational_memory`. */
export interface ObservationalMemoryMeterRow {
  /** Current observation size in tokens (observationTokenCount, NOT NULL integer). */
  readonly observationTokenCount: number;
  /** Running total of all observed tokens (totalTokensObserved, NOT NULL integer). */
  readonly totalTokensObserved: number;
}

/**
 * Strictly parse a raw live-query row into the meter's fields. THROWS on any
 * malformed value (missing/non-integer/negative) so the caller renders an honest
 * error state instead of fabricating a 0. PGlite may serialize integers as
 * strings over the wire, so numeric strings are accepted and coerced.
 */
export function parseObservationalMemoryRow(raw: unknown): ObservationalMemoryMeterRow {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('OM row is not an object');
  }
  const record = raw as Record<string, unknown>;
  return {
    observationTokenCount: parseNonNegativeInteger(
      record['observationTokenCount'],
      'observationTokenCount'
    ),
    totalTokensObserved: parseNonNegativeInteger(
      record['totalTokensObserved'],
      'totalTokensObserved'
    ),
  };
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 0) {
    throw new TypeError(`OM column "${field}" is not a non-negative integer: ${String(value)}`);
  }
  return numeric;
}

export interface OmMeterInput {
  /**
   * Durable assistant usage capability — desktop-only OM persistence signal.
   * MUST be `hasDurableAssistantUsageCapability()`, NOT raw PGlite presence
   * (web is local-first and HAS a PGlite handle but no durable OM rows).
   */
  readonly hasDurableCapability: boolean;
  /**
   * True while the OM live query is fetching (initial load / thread switch) and
   * no row has been delivered yet. Kept separate from `row === null` so the meter
   * does NOT flash the honest-empty state before the first row arrives.
   */
  readonly loading: boolean;
  /** Whether observational memory is enabled in settings (observationalMemory.enabled). */
  readonly omEnabled: boolean;
  /**
   * Live-query error, if the OM subscription itself failed. Surfaced as an
   * honest error state (never a fabricated 0), distinct from a malformed row.
   */
  readonly queryError?: Error | null;
  /** Raw live-query OM row for the active thread, or null when no row exists yet. */
  readonly row: unknown;
}

/**
 * Resolve the OM meter state from the active thread's OM row + flags. Order
 * matters: capability first (web fallback), then OM-enabled, then query error,
 * then loading (quiet, no empty flash), then row presence, then strict parse —
 * each branch is an HONEST state, never a fabricated 0. Note: NO budget or chat
 * input — the observation is informational and cannot feed the budget math.
 */
export function resolveOmMeterState(input: OmMeterInput): OmMeterState {
  if (!input.hasDurableCapability) {
    return { kind: 'chat-only' };
  }
  if (!input.omEnabled) {
    return { kind: 'inactive' };
  }
  if (input.queryError) {
    return { kind: 'error', reason: getErrorMessage(input.queryError) };
  }
  if (input.row === null || input.row === undefined) {
    // Loading is distinct from "no row" so a thread switch (loading + null row)
    // keeps the OM stats quiet instead of flashing "no observations yet".
    return input.loading ? { kind: 'loading' } : { kind: 'empty' };
  }

  let parsed: ObservationalMemoryMeterRow;
  try {
    parsed = parseObservationalMemoryRow(input.row);
  } catch (error: unknown) {
    return { kind: 'error', reason: getErrorMessage(error) };
  }

  return {
    kind: 'stats',
    observationTokens: parsed.observationTokenCount,
    // totalTokensObserved − observationTokenCount, clamped ≥ 0 (tokens compacted
    // away by reflection). 0 here means "active OM, nothing compacted yet" —
    // distinct from the suppressed-stat 'inactive' state.
    compactionSavedTokens: Math.max(0, parsed.totalTokensObserved - parsed.observationTokenCount),
  };
}
