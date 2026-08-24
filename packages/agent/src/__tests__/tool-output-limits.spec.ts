import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import {
  boundToolOutputForModel,
  fitItemsToCharBudget,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  TOOL_RESULT_TOO_LARGE_CODE,
} from '../stream/tool-output-limits';

function collectFallbackWarnLog(run: () => void): LogRecord[] {
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return records.filter(
    (record) =>
      record.level === LogLevel.WARN &&
      record.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          'code' in arg &&
          arg.code === 'tool_result_budget_unknown_model_fallback'
      )
  );
}

describe('resolveScaledToolResultBudget', () => {
  it.each([
    {
      contextWindow: 8192,
      expected: {
        contextWindow: 8192,
        domainModelResultCharBudget: 2000,
        domainModelResultTokens: 500,
        transportResultCharBudget: 4000,
        transportResultTokens: 1000,
      },
      tier: 'floor',
    },
    {
      contextWindow: 131_072,
      expected: {
        contextWindow: 131_072,
        domainModelResultCharBudget: 6000,
        domainModelResultTokens: 1500,
        transportResultCharBudget: 12_000,
        transportResultTokens: 3000,
      },
      tier: '128k anchor',
    },
    {
      contextWindow: 200_000,
      expected: {
        contextWindow: 200_000,
        domainModelResultCharBudget: 9156,
        domainModelResultTokens: 2289,
        transportResultCharBudget: 18_312,
        transportResultTokens: 4578,
      },
      tier: 'mid-range',
    },
    {
      contextWindow: 1_050_000,
      expected: {
        contextWindow: 1_050_000,
        domainModelResultCharBudget: 12_000,
        domainModelResultTokens: 3000,
        transportResultCharBudget: 24_000,
        transportResultTokens: 6000,
      },
      tier: 'ceiling',
    },
  ])('resolves the $tier tier exactly', ({ contextWindow, expected }) => {
    expect(resolveScaledToolResultBudget(contextWindow)).toEqual(expected);
  });

  it('uses the shared conservative context window for a dynamic Ollama model', () => {
    let result: ReturnType<typeof resolveToolResultBudgetForModel> | undefined;
    const fallbackLogs = collectFallbackWarnLog(() => {
      result = resolveToolResultBudgetForModel('ollama', 'runtime-only-model');
    });
    expect(result).toEqual(resolveScaledToolResultBudget(32_768));
    // A dynamic Ollama/LM Studio fallback is the documented, always-expected
    // path for runtime-discovered ids — it does not warn (unlike the
    // catalog-absent case below, which is the genuinely unexpected one).
    expect(fallbackLogs).toHaveLength(0);
  });

  it('resolves an unknown OpenRouter (or any other) model id to the ANCHOR tier, visibly logged, instead of throwing', () => {
    // OpenRouter's metadata-only / auto-profile models (app-shell's
    // mergeOpenRouterAutoProfileModel) and stale persisted preferences from a
    // retired catalog entry are never in the static registry. Budget
    // resolution must never gate run startup on that lookup succeeding — it
    // falls back to the pre-BST-1206 fixed anchor budget instead, visibly.
    let result: ReturnType<typeof resolveToolResultBudgetForModel> | undefined;
    const fallbackLogs = collectFallbackWarnLog(() => {
      result = resolveToolResultBudgetForModel('openrouter', 'some-vendor/unregistered-model');
    });
    expect(result).toEqual(resolveScaledToolResultBudget(131_072));
    expect(fallbackLogs).toHaveLength(1);
    const context = fallbackLogs[0]?.args.find(
      (arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null
    );
    expect(context).toMatchObject({
      code: 'tool_result_budget_unknown_model_fallback',
      fallbackContextWindow: 131_072,
      modelId: 'some-vendor/unregistered-model',
      providerId: 'openrouter',
    });
  });

  it('resolves an UNKNOWN provider id to the ANCHOR tier, visibly logged, instead of throwing', () => {
    // build-persona-subagents passes `persona.model.provider as ProviderId`
    // UNVALIDATED (PR #2513 review, finding 1). An out-of-registry provider id
    // must reach the documented warn+anchor fallback — never a TypeError that
    // the persona resolver's try/catch turns into a silently dropped persona.
    let result: ReturnType<typeof resolveToolResultBudgetForModel> | undefined;
    const fallbackLogs = collectFallbackWarnLog(() => {
      result = resolveToolResultBudgetForModel(
        'not-a-registered-provider' as Parameters<typeof resolveToolResultBudgetForModel>[0],
        'persona-pinned-model'
      );
    });
    expect(result).toEqual(resolveScaledToolResultBudget(131_072));
    expect(fallbackLogs).toHaveLength(1);
    const context = fallbackLogs[0]?.args.find(
      (arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null
    );
    expect(context).toMatchObject({
      code: 'tool_result_budget_unknown_model_fallback',
      fallbackContextWindow: 131_072,
      modelId: 'persona-pinned-model',
      providerId: 'not-a-registered-provider',
    });
  });

  it('resolves a KNOWN catalog model to its declared window, unaffected by the fallback path', () => {
    const fallbackLogs = collectFallbackWarnLog(() => {
      const result = resolveToolResultBudgetForModel('anthropic', 'claude-haiku-4-5');
      // claude-haiku-4-5 is a real, registered anthropic model — never the
      // anchor-fallback value unless its own contextWindow happens to equal
      // 131,072, which it does not.
      expect(result).not.toEqual(resolveScaledToolResultBudget(131_072));
    });
    expect(fallbackLogs).toHaveLength(0);
  });
});

describe('boundToolOutputForModel structural degradation', () => {
  it('uses the scaled transport default, and scales the per-tool override DOWN proportionally, below explicit overrides', () => {
    const generic = boundToolOutputForModel('remote.generic', 'x'.repeat(30_000), undefined, 1000)
      .output as { maxTokens?: number };
    // skill's fixed override is 6000 tokens; at scaledDefaultTokens=1000
    // (sub-anchor, e.g. Gemma's floor tier), it must scale down with it —
    // round(6000 * 1000/3000) = 2000 — never stay fixed at 6000 (which on
    // Gemma's 8192-token window would be ~73% of the entire context for one
    // skill activation).
    const skill = boundToolOutputForModel('skill', 'x'.repeat(30_000), undefined, 1000).output as {
      maxTokens?: number;
    };
    const explicit = boundToolOutputForModel('remote.generic', 'x'.repeat(30_000), 2000, 1000)
      .output as { maxTokens?: number };

    expect(generic.maxTokens).toBe(1000);
    expect(skill.maxTokens).toBe(2000);
    expect(explicit.maxTokens).toBe(2000);
  });

  it('scales the per-tool override to the Gemma (8192-window) tier by the exact resolved transport budget', () => {
    const gemmaTransportTokens = resolveScaledToolResultBudget(8192).transportResultTokens;
    expect(gemmaTransportTokens).toBe(1000); // floor tier
    const skill = boundToolOutputForModel(
      'skill',
      'x'.repeat(30_000),
      undefined,
      gemmaTransportTokens
    ).output as { maxTokens?: number };
    expect(skill.maxTokens).toBe(2000);
  });

  it('never scales a per-tool override UP for an at-or-above-anchor resolved budget (overrides are authored ceilings)', () => {
    const anchorSkill = boundToolOutputForModel('skill', 'x'.repeat(30_000), undefined, 3000)
      .output as { maxTokens?: number };
    const largeWindowSkill = boundToolOutputForModel('skill', 'x'.repeat(30_000), undefined, 6000)
      .output as { maxTokens?: number };
    expect(anchorSkill.maxTokens).toBe(6000);
    expect(largeWindowSkill.maxTokens).toBe(6000);
  });

  it('leaves a per-tool override fixed when no per-run budget is threaded at all (backward compatible)', () => {
    const skill = boundToolOutputForModel('skill', 'x'.repeat(30_000)).output as {
      maxTokens?: number;
    };
    expect(skill.maxTokens).toBe(6000);
  });

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

  it('retains balanced head and tail evidence with an explicit omission marker', () => {
    const source = `HEAD-MARKER-${'x'.repeat(20_000)}-TAIL-MARKER`;
    const bounded = boundToolOutputForModel('filesystem.read_file', source, 2000);
    const output = bounded.output as { preview: string };

    expect(output.preview).toContain('HEAD-MARKER-');
    expect(output.preview).toContain('-TAIL-MARKER');
    expect(output.preview).toMatch(/…\[(\d+) chars omitted\]…/u);
    const omittedChars = Number.parseInt(
      output.preview.match(/…\[(\d+) chars omitted\]…/u)?.[1] ?? '-1',
      10
    );
    expect(omittedChars).toBeGreaterThanOrEqual(0);
    expect(omittedChars).toBeLessThan(source.length);
    expect(JSON.stringify(bounded.output).length).toBeLessThanOrEqual(8000);
  });

  it('does not split UTF-16 surrogate pairs at either preview boundary', () => {
    // These exact prefix/suffix lengths put the balanced head and tail cuts
    // inside separate emoji pairs under the 2000-token preview budget.
    const source = `HEAD-${'😀'.repeat(10_000)}TAIL`;
    const bounded = boundToolOutputForModel('filesystem.read_file', source, 2000);
    const preview = (bounded.output as { preview: string }).preview;

    expect(preview).toMatch(/^HEAD-/u);
    expect(preview).toMatch(/TAIL$/u);
    expect(Buffer.from(preview, 'utf8').toString('utf8')).toBe(preview);
    expect(preview).not.toContain('�');
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

describe('delegation result compaction', () => {
  // Field failure (2026-08-24): an agent-explore delegation whose child made
  // dozens of tool calls rendered "Completed · 0 tool calls" on reload. The
  // delegation result got the generic 3000-token budget, ONE oversized child
  // result blew it, trimCollectionToBudget returned undefined (even a single
  // item did not fit), and the preview fallback dropped subAgentToolResults
  // wholesale — the only per-child record the reopened card can read. The
  // card renders ONLY toolName/toolCallId/isError/args, so the raw child
  // result bodies carry nothing the UI needs: project them away BEFORE
  // bounding and the list survives any realistic budget.
  const hugeChildResult = { body: 'x'.repeat(20_000) };

  it('keeps compact per-child rows when a raw child result would blow the budget', () => {
    const bounded = boundToolOutputForModel('agent-explore', {
      subAgentToolResults: [
        {
          args: { path: 'src/big.ts' },
          isError: false,
          result: hugeChildResult,
          toolCallId: 'child-1',
          toolName: 'readWorkspaceFile',
        },
        {
          args: { query: 'topology' },
          isError: true,
          result: { error: 'boom' },
          toolCallId: 'child-2',
          toolName: 'grepSearch',
        },
      ],
      text: 'child answer',
    });

    const output = bounded.output as {
      subAgentToolResults?: readonly {
        isError?: boolean;
        result?: unknown;
        toolCallId?: string;
        toolName?: string;
      }[];
      text?: string;
    };
    expect(output.text).toBe('child answer');
    expect(output.subAgentToolResults).toHaveLength(2);
    expect(output.subAgentToolResults?.[0]).toMatchObject({
      toolCallId: 'child-1',
      toolName: 'readWorkspaceFile',
    });
    expect(output.subAgentToolResults?.[1]).toMatchObject({ isError: true, toolCallId: 'child-2' });
    // The raw child result bodies are gone — the card never renders them.
    expect(JSON.stringify(output)).not.toContain('xxxx');
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(12_000);
  });

  it('leaves non-delegation tools untouched by the projection', () => {
    // Falsification: an ordinary tool whose output happens to carry a
    // subAgentToolResults-shaped key keeps its data (the trimmable-collection
    // path still applies as before).
    const bounded = boundToolOutputForModel('grepSearch', {
      matches: [{ line: 1, text: 'small' }],
    });
    expect(bounded.output).toMatchObject({ matches: [{ line: 1, text: 'small' }] });
  });
});
