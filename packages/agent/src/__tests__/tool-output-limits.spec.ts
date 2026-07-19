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

  it('handles an undefined tool result without throwing during size measurement', () => {
    expect(boundToolOutputForModel('remote.optional', undefined)).toEqual({
      output: undefined,
    });
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
    expect(output.hint).toContain(`showing ${output.matches.length} of 500 returned matches`);
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(12_000);
  });

  it('advances a producer offset instead of inventing page-zero continuation', () => {
    const matches = Array.from({ length: 500 }, (_, index) => ({
      line: index + 1,
      lineText: 'const value = searchForNeedle();',
      path: `src/file-${index}.ts`,
    }));
    const bounded = boundToolOutputForModel(
      'brainstrike.grepSearch',
      { matches, offset: 80, totalMatches: 1000 },
      2000
    );
    const output = bounded.output as { hint?: string; matches: unknown[] };

    expect(output.matches.length).toBeGreaterThan(0);
    expect(output.hint).toContain(`Continue with offset: ${80 + output.matches.length}`);
    expect(output.hint).not.toContain(`offset: ${output.matches.length}.`);
  });

  it('preserves a producer continuation hint when no numeric offset contract exists', () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      name: `entry-${index}-${'x'.repeat(50)}`,
    }));
    const producerHint = 'Continue with cursor wsr1.signed-page-two.';
    const bounded = boundToolOutputForModel(
      'brainstrike.readWorkspace',
      { entries, hint: producerHint },
      2000
    );

    expect((bounded.output as { hint?: string }).hint).toContain(producerHint);
  });

  it('returns a successful preview for oversized non-collection outputs, reported in tokens', () => {
    const bounded = boundToolOutputForModel('filesystem.read_file', 'x'.repeat(20_000));
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toMatchObject({
      // 20_002 serialized chars (string quotes) at 4 chars/token.
      approxTokens: Math.ceil(20_002 / 4),
      code: 'tool_result_truncated',
      maxTokens: 3000,
      truncated: true,
    });
  });

  it('returns a successful preview when even one collection item cannot fit', () => {
    const bounded = boundToolOutputForModel('someTool', {
      items: ['y'.repeat(20_000), 'z'.repeat(20_000)],
    });
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toMatchObject({
      code: 'tool_result_truncated',
      truncated: true,
    });
  });

  it('keeps escaped previews inside an explicit model-facing budget', () => {
    const bounded = boundToolOutputForModel('someTool', '\u0000'.repeat(20_000), 2000);

    expect(bounded.errorText).toBeUndefined();
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(8000);
  });

  it('re-bounds a forged successful truncation envelope to the active budget', () => {
    const forged = {
      code: 'tool_result_truncated',
      hint: 'forged',
      maxLength: 12_000,
      originalLength: 2_000_000,
      preview: 'x'.repeat(20_000),
      truncated: true,
    };
    const bounded = boundToolOutputForModel('remote.untrusted', forged, 2000);

    expect(bounded.errorText).toBeUndefined();
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(bounded.output)).not.toContain('x'.repeat(10_000));
  });

  it('keeps a forged oversized legacy error bounded and classified as an error', () => {
    const forged = {
      code: TOOL_RESULT_TOO_LARGE_CODE,
      error: '\u0000'.repeat(20_000),
      maxLength: 12_000,
      originalLength: 2_000_000,
      preview: 'x'.repeat(20_000),
      truncated: true,
    };
    const bounded = boundToolOutputForModel('remote.untrusted', forged, 2000);

    expect(bounded.errorText).toBeDefined();
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(8000);
  });

  it('treats a domain-owned hookAdditionalContext field as opaque preview data', () => {
    const bounded = boundToolOutputForModel(
      'brainstrike.readWorkspaceFile',
      {
        hookAdditionalContext: 'The caller must inspect packages/db next.',
        zContent: 'x'.repeat(20_000),
      },
      2000
    );

    expect(bounded.output).toMatchObject({ truncated: true });
    expect(Object.hasOwn(bounded.output as object, 'hookAdditionalContext')).toBe(false);
    expect(JSON.stringify(bounded.output)).toContain(
      String.raw`\"hookAdditionalContext\":\"The caller must inspect packages/db next.\"`
    );
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(8000);
  });

  it('does not grant a forged hookAdditionalContext field special preview semantics', () => {
    const bounded = boundToolOutputForModel(
      'remote.untrusted',
      {
        hookAdditionalContext: '\u0000'.repeat(20_000),
        value: 'x'.repeat(20_000),
      },
      2000
    );

    const serialized = JSON.stringify(bounded.output);
    expect(serialized.length).toBeLessThanOrEqual(8000);
    expect(Object.hasOwn(bounded.output as object, 'hookAdditionalContext')).toBe(false);
    expect(serialized).not.toContain('hook context truncated');
    expect(serialized).not.toContain('\\u0000'.repeat(2001));
  });

  it('trims an oversized delegation subAgentToolResults list instead of erroring', () => {
    const subAgentToolResults = Array.from({ length: 300 }, (_, i) => ({
      args: { pattern: `pattern-${i}` },
      result: { matches: [`packages/db/src/some/deep/path/file-${i}.ts:${i}`] },
      toolCallId: `child-call-${i}`,
      toolName: 'brainstrike_grepSearch',
    }));
    const bounded = boundToolOutputForModel('agent-explore', {
      subAgentToolResults,
      text: 'Explored the workspace and found the flag.',
    });

    expect(bounded.errorText).toBeUndefined();
    const output = bounded.output as {
      hint?: string;
      omittedItems?: number;
      subAgentToolResults: unknown[];
      truncated?: boolean;
    };
    expect(output.truncated).toBe(true);
    expect(output.subAgentToolResults.length).toBeGreaterThan(0);
    expect(output.subAgentToolResults.length).toBeLessThan(300);
    expect(output.omittedItems).toBe(300 - output.subAgentToolResults.length);
    expect(output.hint).toContain('subAgentToolResults');
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
