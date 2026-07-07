import { describe, expect, it } from 'vitest';
import {
  computeContextSelectedTokenSummary,
  createSelectedFileContentSnapshot,
  hasSameSelectedFileContentSnapshot,
  type TapestryRangeMap,
} from '../context-selected-token-summary';

const createRange = (overrides: Partial<{ isActive: boolean }> = {}) => ({
  color: '#22c55e',
  endLine: 1,
  id: 'range-1',
  isActive: overrides.isActive ?? true,
  startLine: 0,
});

describe('computeContextSelectedTokenSummary', () => {
  it('applies active ranges only for selected files', () => {
    const summary = computeContextSelectedTokenSummary({
      fileContents: {
        'a.ts': 'a\nb',
        'b.ts': 'a\nb',
      },
      selectedFiles: new Set(['a.ts']),
      sourcePendingCount: 0,
      sourceSelectedTokens: 30,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
        'b.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([
        ['a.ts', 30],
        ['b.ts', 30],
      ]),
      useTapestryRangesForContextOutput: true,
    });

    expect(summary.outputSelectedTokens).toBe(20);
    expect(summary.rangeAdjustedFilesCount).toBe(1);
    expect(summary.activeRangeFilesCount).toBe(1);
  });

  it('does not count range-adjusted files when token counts are unavailable', () => {
    const summary = computeContextSelectedTokenSummary({
      fileContents: {
        'a.ts': 'a',
      },
      selectedFiles: new Set(['a.ts']),
      sourcePendingCount: 1,
      sourceSelectedTokens: 10,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map(),
      useTapestryRangesForContextOutput: true,
    });

    expect(summary.outputSelectedTokens).toBe(10);
    expect(summary.outputPendingCount).toBe(1);
    expect(summary.rangeAdjustedFilesCount).toBe(0);
    expect(summary.activeRangeFilesCount).toBe(0);
  });

  it('treats fully inactive ranges as zero-token output for the file', () => {
    const summary = computeContextSelectedTokenSummary({
      fileContents: {
        'a.ts': 'a\nb',
      },
      selectedFiles: new Set(['a.ts']),
      sourcePendingCount: 0,
      sourceSelectedTokens: 30,
      tapestryRangesByKey: {
        'a.ts': [createRange({ isActive: false })],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([['a.ts', 30]]),
      useTapestryRangesForContextOutput: true,
    });

    expect(summary.outputSelectedTokens).toBe(0);
    expect(summary.rangeAdjustedFilesCount).toBe(1);
    expect(summary.activeRangeFilesCount).toBe(0);
  });

  it('returns source totals untouched when tapestry ranges are disabled', () => {
    const summary = computeContextSelectedTokenSummary({
      fileContents: {
        'a.ts': 'a\nb',
      },
      selectedFiles: new Set(['a.ts']),
      sourcePendingCount: 3,
      sourceSelectedTokens: 42,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([['a.ts', 42]]),
      useTapestryRangesForContextOutput: false,
    });

    expect(summary).toEqual({
      activeRangeFilesCount: 0,
      outputPendingCount: 3,
      outputSelectedTokens: 42,
      rangeAdjustedFilesCount: 0,
      sourcePendingCount: 3,
      sourceSelectedTokens: 42,
    });
  });

  it('applies additive range adjustments while preserving source token baseline mismatches', () => {
    const summary = computeContextSelectedTokenSummary({
      fileContents: {
        'a.ts': 'a\nb',
        'b.ts': 'a\nb',
      },
      selectedFiles: new Set(['a.ts', 'b.ts']),
      sourcePendingCount: 0,
      sourceSelectedTokens: 20,
      tapestryRangesByKey: {
        'a.ts': [createRange()],
      } satisfies TapestryRangeMap,
      tokenCountByFile: new Map([
        ['a.ts', 30],
        ['b.ts', 5],
      ]),
      useTapestryRangesForContextOutput: true,
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
      fileContents: {
        'a.ts': 'alpha',
        'b.ts': 'beta',
        'c.ts': 'gamma',
      },
      selectedFiles: new Set(['a.ts', 'b.ts']),
      tapestryRangesByKey: {
        'a.ts': [createRange()],
        'b.ts': [],
        'c.ts': [createRange()],
      } satisfies TapestryRangeMap,
    });

    expect(snapshot).toEqual({ 'a.ts': 'alpha' });
  });
});

describe('hasSameSelectedFileContentSnapshot', () => {
  it('compares snapshots by keys and values', () => {
    expect(
      hasSameSelectedFileContentSnapshot(
        { 'a.ts': 'alpha', 'b.ts': 'beta' },
        { 'a.ts': 'alpha', 'b.ts': 'beta' }
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
