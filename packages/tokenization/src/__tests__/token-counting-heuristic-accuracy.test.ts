import { describe, expect, it } from 'vitest';
import { countTokensHeuristic } from '../token-counting-heuristics.js';
import { getAccurateTokenCounter } from '../token-utils-accurate-lite.js';

/**
 * BST-940: pin the chars/4 heuristic against the REAL o200k_base tokenizer on
 * representative content classes so the context meter's "~" figures cannot
 * silently drift into wildly-wrong territory. Measured 2026-07-27:
 *   code      ≈ 4.17 chars/token → heuristic ratio ≈ 1.04 (near-exact)
 *   tool JSON ≈ 3.13 chars/token → heuristic ratio ≈ 0.78 (undercounts ~22%)
 *   prose     ≈ 4.3–5.8 chars/token → heuristic ratio ≈ 1.1–1.45 (overcounts)
 * The pinned windows are deliberately wider than the point measurements so a
 * tokenizer-version bump doesn't false-fail, but narrow enough that an
 * order-of-magnitude regression (the v1 "extremely low" class of bug) fails.
 */

const PROSE_SAMPLE =
  'The context usage meter shows how much of the model window the conversation occupies. When the estimate approaches the effective input budget, older messages may be trimmed by the token limiter before the next request. Users should be able to trust the displayed number as a faithful estimate of what the provider will see. '.repeat(
    30
  );

const CODE_SAMPLE = `export function resolveDisplayedContextUsage(args: {
  breakdownBaselineTokens: number;
  conversationEstimateTokens: number;
  exact: { inputTokens: number; outputTokens: number } | undefined;
  isRunning: boolean;
}): DisplayedContextUsage {
  const exactTotal = args.exact ? args.exact.inputTokens + args.exact.outputTokens : undefined;
  const liveEstimate = args.breakdownBaselineTokens + args.conversationEstimateTokens;
  if (args.isRunning) {
    return { isEstimated: true, usedTokens: Math.max(liveEstimate, exactTotal ?? 0) };
  }
  return { isEstimated: false, usedTokens: 0 };
}
`.repeat(25);

const TOOL_JSON_SAMPLE = JSON.stringify({
  entries: Array.from({ length: 120 }, (_, index) => ({
    isDirectory: index % 3 === 0,
    modifiedAt: '2026-07-27T04:12:33.000Z',
    name: `src/components/assistant-ui-panel/context-usage-${index}.tsx`,
    sizeBytes: 1024 * index,
  })),
  ok: true,
  root: 'root-main',
});

async function requireCounter(): Promise<(text: string) => number> {
  const counter = await getAccurateTokenCounter();
  if (!counter) {
    throw new Error('o200k_base counter must load in the unit-test environment');
  }
  return counter;
}

describe('countTokensHeuristic accuracy vs o200k_base', () => {
  it('is near-exact on TypeScript code (the dominant assistant content class)', async () => {
    const counter = await requireCounter();
    const ratio = countTokensHeuristic(CODE_SAMPLE) / counter(CODE_SAMPLE);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.25);
  });

  it('undercounts dense tool JSON by a bounded margin (never an order of magnitude)', async () => {
    const counter = await requireCounter();
    const ratio = countTokensHeuristic(TOOL_JSON_SAMPLE) / counter(TOOL_JSON_SAMPLE);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.1);
  });

  it('overcounts repetitive prose by a bounded margin', async () => {
    const counter = await requireCounter();
    const ratio = countTokensHeuristic(PROSE_SAMPLE) / counter(PROSE_SAMPLE);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.6);
  });

  it('a mixed conversation-shaped corpus stays within ±30% of exact', async () => {
    const counter = await requireCounter();
    const mixed = `${PROSE_SAMPLE}\n${CODE_SAMPLE}\n${TOOL_JSON_SAMPLE}`;
    const ratio = countTokensHeuristic(mixed) / counter(mixed);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });
});
