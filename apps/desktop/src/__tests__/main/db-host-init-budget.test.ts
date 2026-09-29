import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS,
  DB_HOST_INIT_MAX_BUDGET_MS,
  DB_HOST_INIT_MIGRATION_BUDGET_MS,
  DB_HOST_INIT_MIN_PHASE_BUDGET_MS,
  DB_HOST_INIT_PHASE_FLOOR_MS,
  DB_HOST_REINDEX_BUDGET_BYTES_PER_MS,
  DB_HOST_WAL_REDO_BUDGET_BYTES_PER_MS,
  resolveInitPhaseBudgetMs,
} from '../../db-host-init-budget';

const MIB = 1024 * 1024;

function rebuild(heapBytes: number, toastBytes: number): DatabaseInitPhaseReport {
  return {
    index: {
      accessMethod: 'bm25',
      heapBytes,
      index: 'idx_file_chunks_content_bm25',
      indexBytes: 32 * MIB,
      schema: 'public',
      table: 'file_chunks',
      toastBytes,
    },
    phase: 'index-rebuild',
  };
}

function open(pgWalBytes: number): DatabaseInitPhaseReport {
  return { pgWalBytes, phase: 'open-database' };
}

describe('resolveInitPhaseBudgetMs', () => {
  // The constants are measured policy (BST-1883, docs/agents/database/pg-textsearch-qualification.md).
  // Re-measure and re-pin; never raise one to absorb a slow phase.
  it('pins the constants to the measured envelope', () => {
    expect(DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS).toBe(90_000);
    expect(DB_HOST_INIT_PHASE_FLOOR_MS).toBe(30_000);
    expect(DB_HOST_INIT_MIGRATION_BUDGET_MS).toBe(90_000);
    // No phase gets less than the single 90 s deadline this replaced (unmeasured platforms).
    expect(DB_HOST_INIT_MIN_PHASE_BUDGET_MS).toBe(90_000);
    // 4 MiB/s of pg_wal and 1 MiB/s of heap+toast, expressed per millisecond.
    expect(DB_HOST_WAL_REDO_BUDGET_BYTES_PER_MS).toBeCloseTo((4 * MIB) / 1000, 9);
    expect(DB_HOST_REINDEX_BUDGET_BYTES_PER_MS).toBeCloseTo(MIB / 1000, 9);
    // The longest delay Node's setTimeout honours; a longer one fires after 1 ms.
    expect(DB_HOST_INIT_MAX_BUDGET_MS).toBe(2_147_483_647);
  });

  it('pins the phase budgets to the measured envelope', () => {
    // Byte counts are the measured MiB figures rounded UP to whole MiB, so each budget is exact.
    // Incident database rebuild: 130.7 heap + 211.4 toast, measured at 12 s -> 30 s + 342 s.
    expect(resolveInitPhaseBudgetMs(rebuild(131 * MIB, 211 * MIB))).toBe(372_000);
    // 1M x 123-char rows: 205.5 MiB heap, measured at 20 s -> 30 s + 206 s.
    expect(resolveInitPhaseBudgetMs(rebuild(206 * MIB, 0))).toBe(236_000);
    // 100k x 1420-char rows: 156.3 MiB heap, measured at 22 s -> 30 s + 157 s.
    expect(resolveInitPhaseBudgetMs(rebuild(157 * MIB, 0))).toBe(187_000);
    // The incident backup's 912 MiB of pg_wal (clean open 0.24 s) -> 30 s + 228 s.
    expect(resolveInitPhaseBudgetMs(open(912 * MIB))).toBe(258_000);
    // A new database, or one with no WAL on disk, gets the minimum: today's 90 s, never less.
    expect(resolveInitPhaseBudgetMs(open(0))).toBe(90_000);
    // 136 migrations measured at 0.84 s; the budget is today's whole-init value.
    expect(resolveInitPhaseBudgetMs({ phase: 'migration' })).toBe(90_000);
  });

  it('never gives a phase less than the 90 s deadline it replaced, and counts heap and toast, not index bytes', () => {
    expect(resolveInitPhaseBudgetMs(rebuild(0, 0))).toBe(DB_HOST_INIT_MIN_PHASE_BUDGET_MS);
    expect(resolveInitPhaseBudgetMs(rebuild(MIB, 2 * MIB))).toBe(DB_HOST_INIT_MIN_PHASE_BUDGET_MS);
    // Above the minimum the size counts: 60 + 10 MiB -> 30 s floor + 70 s. indexBytes (32 MiB in
    // the fixture) must not add to the budget.
    expect(resolveInitPhaseBudgetMs(rebuild(60 * MIB, 10 * MIB))).toBe(100_000);
  });

  it('rounds a fractional budget up to a whole millisecond', () => {
    // 60 MiB is exactly 60 s at 1 MiB/s; one more byte is 0.00095 ms, still a whole millisecond.
    expect(resolveInitPhaseBudgetMs(rebuild(60 * MIB + 1, 0))).toBe(
      DB_HOST_INIT_PHASE_FLOOR_MS + 60_001
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative count', -1],
  ])(
    'throws for %s bytes in every report that carries bytes, never falling back to the floor',
    (_label, bytes) => {
      expect(() => resolveInitPhaseBudgetMs(open(bytes))).toThrow(TypeError);
      expect(() => resolveInitPhaseBudgetMs(rebuild(bytes, 0))).toThrow(TypeError);
      expect(() => resolveInitPhaseBudgetMs(rebuild(0, bytes))).toThrow(TypeError);
    }
  );

  it('validates heap and toast separately, so a negative count cannot hide behind a positive one', () => {
    expect(() => resolveInitPhaseBudgetMs(rebuild(-1, 2 * MIB))).toThrow(TypeError);
    expect(() => resolveInitPhaseBudgetMs(rebuild(2 * MIB, -1))).toThrow(TypeError);
  });

  it('throws for a budget past the longest timer instead of arming one that fires at once', () => {
    expect(() => resolveInitPhaseBudgetMs(open(Number.MAX_SAFE_INTEGER))).toThrow(RangeError);
    expect(() => resolveInitPhaseBudgetMs(rebuild(Number.MAX_SAFE_INTEGER, 0))).toThrow(RangeError);
  });
});
