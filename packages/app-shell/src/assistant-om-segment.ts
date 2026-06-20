/**
 * Observational-memory (OM) tri-segment meter derivation.
 *
 * The context meter (packages/ui/src/assistant-ui-panel/context-usage-meter.tsx)
 * shows a unified segmented bar — chat / observation / free — against the single
 * `effectiveInputBudget`, plus a "reflection saved ~Nk" compaction stat. The OM
 * segment + compaction numerator are read RAW off the `mastra_observational_memory`
 * row for the active thread (see assistant-om-segment-row.ts + the projection
 * drift guard in packages/db/__tests__/mastra-om-schema-projection.test.ts).
 *
 * This module is the PURE derivation: row + flags + budget → a discriminated
 * OmMeterState. It is deliberately framework-free so the math, the capability
 * split, and the honest empty/error/inactive states are unit-testable without a
 * DB or React.
 *
 * No-silent-fallbacks contract (the bots flagged this exact pattern on 5.1/5.2):
 *   - web (no durable capability) → 'chat-only' (segments collapse to chat) — NOT zeros.
 *   - OM disabled                 → 'inactive'  (explicit) — NOT "0 saved".
 *   - no OM row yet               → 'empty'     — NOT a throw, NOT zeros.
 *   - malformed OM row            → 'error'     (strict parser throws, caught here) — NEVER fabricated 0.
 *   - over budget                 → honest negative `freeTokens` + `overBudget` — NEVER hidden.
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
  /** Last-turn chat tokens (inputTokens + outputTokens) from the session usage store. */
  readonly chatTokens: number;
  /** Single budget denominator (deriveEffectiveInputBudget) — reused, never forked. */
  readonly effectiveInputBudget: number;
  /**
   * Durable assistant usage capability — desktop-only OM persistence signal.
   * MUST be `hasDurableAssistantUsageCapability()`, NOT raw PGlite presence
   * (web is local-first and HAS a PGlite handle but no durable OM rows).
   */
  readonly hasDurableCapability: boolean;
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
 * Resolve the tri-segment meter state from the active thread's OM row + flags.
 * Order matters: capability first (web fallback), then OM-enabled, then row
 * presence, then strict parse — each branch is an HONEST state, never a 0.
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
    return { kind: 'empty' };
  }

  let parsed: ObservationalMemoryMeterRow;
  try {
    parsed = parseObservationalMemoryRow(input.row);
  } catch (error: unknown) {
    return { kind: 'error', reason: getErrorMessage(error) };
  }

  const observationTokens = parsed.observationTokenCount;
  const used = input.chatTokens + observationTokens;
  const freeTokens = input.effectiveInputBudget - used;
  const compactionSavedTokens = Math.max(0, parsed.totalTokensObserved - observationTokens);

  return {
    kind: 'segments',
    chatTokens: input.chatTokens,
    observationTokens,
    freeTokens,
    overBudget: freeTokens < 0,
    compactionSavedTokens,
  };
}
