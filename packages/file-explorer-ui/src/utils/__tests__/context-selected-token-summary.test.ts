import { describe, expect, it } from 'vitest';
import {
  computeContextSelectedTokenSummary,
  createSelectedFileContentSnapshot,
  hasSameSelectedFileContentSnapshot,
  type TapestryRangeMap,
} from '../context-selected-token-summary';

const createRange = (overrides: Partial<{ isActive: boolean }> = {}) => ({
  id: 'range-1',
  startLine: 0,
  endLine: 1,
  isActive: overrides.isActive ?? true,
  color: '#22c55e',
});

describe('computeContextSelectedTokenSummary', () => {
  it('applies active ranges only for selected files', () => {
    const summary = computeContextSelectedTokenSummary({
      sourceSelectedTokens: 30,
      sourcePendingCount: 0,
      selectedFiles: new Set(['a.ts']),
      useTapestryRangesForContextOutput: true,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
        'b.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([
        ['a.ts', 30],
        ['b.ts', 30],
      ]),
      fileContents: {
        'a.ts': 'a\nb',
        'b.ts': 'a\nb',
      },
    });

    expect(summary.outputSelectedTokens).toBe(20);
    expect(summary.rangeAdjustedFilesCount).toBe(1);
    expect(summary.activeRangeFilesCount).toBe(1);
  });

  it('does not count range-adjusted files when token counts are unavailable', () => {
    const summary = computeContextSelectedTokenSummary({
      sourceSelectedTokens: 10,
      sourcePendingCount: 1,
      selectedFiles: new Set(['a.ts']),
      useTapestryRangesForContextOutput: true,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map(),
      fileContents: {
        'a.ts': 'a',
      },
    });

    expect(summary.outputSelectedTokens).toBe(10);
    expect(summary.outputPendingCount).toBe(1);
    expect(summary.rangeAdjustedFilesCount).toBe(0);
    expect(summary.activeRangeFilesCount).toBe(0);
  });

  it('treats fully inactive ranges as zero-token output for the file', () => {
    const summary = computeContextSelectedTokenSummary({
      sourceSelectedTokens: 30,
      sourcePendingCount: 0,
      selectedFiles: new Set(['a.ts']),
      useTapestryRangesForContextOutput: true,
      tapestryRangesByKey: {
        'a.ts': [createRange({ isActive: false })],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([['a.ts', 30]]),
      fileContents: {
        'a.ts': 'a\nb',
      },
    });

    expect(summary.outputSelectedTokens).toBe(0);
    expect(summary.rangeAdjustedFilesCount).toBe(1);
    expect(summary.activeRangeFilesCount).toBe(0);
  });

  it('returns source totals untouched when tapestry ranges are disabled', () => {
    const summary = computeContextSelectedTokenSummary({
      sourceSelectedTokens: 42,
      sourcePendingCount: 3,
      selectedFiles: new Set(['a.ts']),
      useTapestryRangesForContextOutput: false,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([['a.ts', 42]]),
      fileContents: {
        'a.ts': 'a\nb',
      },
    });

    expect(summary).toEqual({
      sourceSelectedTokens: 42,
      outputSelectedTokens: 42,
      sourcePendingCount: 3,
      outputPendingCount: 3,
      rangeAdjustedFilesCount: 0,
      activeRangeFilesCount: 0,
    });
  });

  it('applies additive range adjustments while preserving source token baseline mismatches', () => {
    const summary = computeContextSelectedTokenSummary({
      sourceSelectedTokens: 20,
      sourcePendingCount: 0,
      selectedFiles: new Set(['a.ts', 'b.ts']),
      useTapestryRangesForContextOutput: true,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([
        ['a.ts', 30],
        ['b.ts', 5],
      ]),
      fileContents: {
        'a.ts': 'a\nb',
        'b.ts': 'a\nb',
      },
    });

    // a.ts range keeps ~20 tokens (from 30) and b.ts is unadjusted (+5),
    // then baseline mismatch is preserved from sourceSelectedTokens (20).
    expect(summary.outputSelectedTokens).toBe(10);
    expect(summary.rangeAdjustedFilesCount).toBe(1);
    expect(summary.activeRangeFilesCount).toBe(1);
  });
});

describe('createSelectedFileContentSnapshot', () => {
  it('collects only selected files with explicit ranges and loaded content', () => {
    const snapshot = createSelectedFileContentSnapshot({
      selectedFiles: new Set(['a.ts', 'b.ts']),
      tapestryRangesByKey: {
        'a.ts': [createRange()],
        'b.ts': [],
        'c.ts': [createRange()],
      } satisfies TapestryRangeMap,
      fileContents: {
        'a.ts': 'alpha',
        'b.ts': 'beta',
        'c.ts': 'gamma',
      },
    });

    expect(snapshot).toEqual({ 'a.ts': 'alpha' });
  });
});

describe('hasSameSelectedFileContentSnapshot', () => {
  it('compares snapshots by keys and values', () => {
    expect(
      hasSameSelectedFileContentSnapshot(
        { 'a.ts': 'alpha', 'b.ts': 'beta' },
        { 'b.ts': 'beta', 'a.ts': 'alpha' }
      )
    ).toBe(true);

    expect(
      hasSameSelectedFileContentSnapshot({ 'a.ts': 'alpha' }, { 'a.ts': 'alpha', 'b.ts': 'beta' })
    ).toBe(false);

    expect(
      hasSameSelectedFileContentSnapshot({ 'a.ts': 'alpha' }, { 'a.ts': 'alpha-updated' })
    ).toBe(false);
  });
});
