import { describe, expect, it } from 'vitest';
import {
  boundToolOutputForModel,
  fitItemsToCharBudget,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  TOOL_RESULT_TOO_LARGE_CODE,
} from '../stream/tool-output-limits';

describe('boundToolOutputForModel structural degradation', () => {
  it('returns small outputs unchanged', () => {
    const output = { matches: [{ path: 'a.ts' }], totalMatches: 1 };
    const bounded = boundToolOutputForModel('brainstrike.grepSearch', output);
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toEqual(output);
  });

  it('trims an oversized collection result to fit instead of erroring', () => {
    const matches = Array.from({ length: 500 }, (_, i) => ({
      line: i + 1,
      lineText: 'const db = new PGlite(dataDir, { extensions });',
      path: `packages/db/src/some/deep/path/file-${i}.ts`,
    }));
    const bounded = boundToolOutputForModel('brainstrike.grepSearch', {
      matches,
      totalMatches: 500,
    });

    // Successful partial result, not a tool error.
    expect(bounded.errorText).toBeUndefined();
    const output = bounded.output as {
      hint?: string;
      matches: unknown[];
      omittedItems?: number;
      totalMatches: number;
      truncated?: boolean;
    };
    expect(output.truncated).toBe(true);
    expect(output.matches.length).toBeGreaterThan(0);
    expect(output.matches.length).toBeLessThan(500);
    expect(output.omittedItems).toBe(500 - output.matches.length);
    expect(output.totalMatches).toBe(500);
    expect(output.hint).toContain(`showing ${output.matches.length} of 500 matches`);
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(12_000);
  });

  it('keeps the error+preview path for oversized non-collection outputs, reported in tokens', () => {
    const bounded = boundToolOutputForModel('filesystem.read_file', 'x'.repeat(20_000));
    expect(bounded.errorText).toContain('returned too much output');
    expect(bounded.errorText).toContain('tokens');
    expect(bounded.output).toMatchObject({
      // 20_002 serialized chars (string quotes) at 4 chars/token.
      approxTokens: Math.ceil(20_002 / 4),
      code: TOOL_RESULT_TOO_LARGE_CODE,
      maxTokens: 3000,
      truncated: true,
    });
  });

  it('falls back to the error path when even one collection item cannot fit', () => {
    const bounded = boundToolOutputForModel('someTool', {
      items: ['y'.repeat(20_000), 'z'.repeat(20_000)],
    });
    expect(bounded.errorText).toContain('returned too much output');
  });

  it('is idempotent for structurally trimmed results', () => {
    const matches = Array.from({ length: 500 }, (_, i) => ({
      line: i,
      lineText: 'const db = new PGlite(dataDir, { extensions });',
      path: `packages/db/src/file-${i}.ts`,
    }));
    const first = boundToolOutputForModel('tool', { matches, totalMatches: 500 });
    const second = boundToolOutputForModel('tool', first.output);
    expect(second.errorText).toBeUndefined();
    expect(second.output).toEqual(first.output);
  });
});

describe('fitItemsToCharBudget', () => {
  const build = (items: string[]) => ({ entries: items, total: items.length });

  it('keeps everything when the full result fits', () => {
    const { kept, result } = fitItemsToCharBudget(['a', 'b', 'c'], build);
    expect(kept).toBe(3);
    expect(result.entries).toEqual(['a', 'b', 'c']);
  });

  it('finds the largest prefix that fits a small budget', () => {
    const items = Array.from({ length: 100 }, (_, i) => `entry-${i}-${'pad'.repeat(10)}`);
    const { kept, result } = fitItemsToCharBudget(items, build, 500);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(100);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(500);
    // One more item would overflow.
    const oneMore = build(items.slice(0, kept + 1));
    expect(JSON.stringify(oneMore).length).toBeGreaterThan(500);
  });

  it('returns the empty build when nothing fits', () => {
    const { kept, result } = fitItemsToCharBudget(['x'.repeat(1000)], build, 50);
    expect(kept).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('uses the native budget by default', () => {
    expect(NATIVE_TOOL_RESULT_CHAR_BUDGET).toBeLessThan(12_000);
  });
});
