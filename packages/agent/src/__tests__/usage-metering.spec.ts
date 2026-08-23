import { describe, expect, it } from 'vitest';
import {
  accumulateSteppedUsage,
  readCacheTokenCount,
  readOpenRouterBilledCost,
  readOpenRouterDiagnostics,
  readStreamPartUsage,
  type UsageMeteringState,
} from '../mastra/runtime-assembly/usage-metering';

describe('readStreamPartUsage', () => {
  it('reads the nested payload.output shape a real Mastra part emits', () => {
    expect(
      readStreamPartUsage({ payload: { output: { usage: { inputTokens: 7, outputTokens: 3 } } } })
    ).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('falls back through payload.metadata', () => {
    expect(readStreamPartUsage({ payload: { metadata: { usage: { promptTokens: 11 } } } })).toEqual(
      { promptTokens: 11 }
    );
  });

  it('still accepts the top-level shape (test fixtures / single-step transports)', () => {
    expect(readStreamPartUsage({ usage: { completionTokens: 2, promptTokens: 5 } })).toEqual({
      completionTokens: 2,
      promptTokens: 5,
    });
  });

  it('SKIPS a present-but-countless candidate for one that resolves counts', () => {
    // AI SDK v5 can emit a top-level `usage` with all-undefined fields while
    // the real numbers sit in payload.output — selecting on mere presence
    // would silently report zero tokens (review finding).
    expect(
      readStreamPartUsage({
        payload: { output: { usage: { inputTokens: 900, outputTokens: 40 } } },
        usage: { completionTokens: undefined, promptTokens: undefined },
      })
    ).toEqual({ inputTokens: 900, outputTokens: 40 });
  });

  it('returns the first present candidate when NO candidate resolves counts', () => {
    // Honest empty usage beats undefined: the caller can still distinguish
    // "reported nothing" from "no usage object at all".
    expect(readStreamPartUsage({ usage: {} })).toEqual({});
    expect(readStreamPartUsage({})).toBeUndefined();
  });
});

describe('readCacheTokenCount', () => {
  it('returns positive finite counts', () => {
    expect(readCacheTokenCount(42)).toBe(42);
  });

  it('drops zero, negative, non-finite, and absent values', () => {
    expect(readCacheTokenCount(0)).toBeUndefined();
    expect(readCacheTokenCount(-1)).toBeUndefined();
    expect(readCacheTokenCount(Number.NaN)).toBeUndefined();
    expect(readCacheTokenCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readCacheTokenCount(undefined)).toBeUndefined();
  });
});

describe('readOpenRouterBilledCost', () => {
  it('reports ABSENT when no provider metadata is present', () => {
    expect(readOpenRouterBilledCost({})).toEqual({ kind: 'absent' });
  });

  it('reports ABSENT when the openrouter namespace or usage/cost is missing', () => {
    expect(readOpenRouterBilledCost({ providerMetadata: {} })).toEqual({ kind: 'absent' });
    expect(readOpenRouterBilledCost({ providerMetadata: { openrouter: {} } })).toEqual({
      kind: 'absent',
    });
    expect(readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: {} } } })).toEqual({
      kind: 'absent',
    });
  });

  it('reports the billed cost from top-level provider metadata', () => {
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost: 0.0125 } } } })
    ).toEqual({ kind: 'reported', usd: 0.0125 });
  });

  it('prefers the payload metadata location over the top-level field', () => {
    expect(
      readOpenRouterBilledCost({
        payload: {
          metadata: { providerMetadata: { openrouter: { usage: { cost: 0.5 } } } },
        },
        providerMetadata: { openrouter: { usage: { cost: 9 } } },
      })
    ).toEqual({ kind: 'reported', usd: 0.5 });
  });

  it('reports MALFORMED rather than throwing, and never coerces it to a number', () => {
    // Malformed stays a distinct, represented fact — it is not absent and it is
    // certainly not zero, since a fabricated zero is the undercount this whole
    // path exists to avoid. Returning it instead of throwing is what stops a
    // broken provider contract from destroying a completed turn; the callers
    // log it at ERROR so it remains impossible to miss.
    expect(readOpenRouterBilledCost({ providerMetadata: 'nope' })).toMatchObject({
      kind: 'malformed',
    });
    expect(readOpenRouterBilledCost({ providerMetadata: { openrouter: 7 } })).toMatchObject({
      kind: 'malformed',
    });
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: 'x' } } })
    ).toMatchObject({ kind: 'malformed', reason: /usage metadata must be an object/ });
    for (const cost of ['1', -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost } } } })
      ).toMatchObject({ kind: 'malformed', reason: /finite, non-negative/ });
    }
  });

  it('reports a zero cost as REPORTED — a measured zero is a real amount', () => {
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost: 0 } } } })
    ).toEqual({ kind: 'reported', usd: 0 });
  });
});

describe('readOpenRouterDiagnostics', () => {
  it('reads the selected upstream provider and reasoning-token count', () => {
    expect(
      readOpenRouterDiagnostics({
        providerMetadata: {
          openrouter: {
            provider: 'Together',
            usage: { completionTokensDetails: { reasoningTokens: 4096 } },
          },
        },
      })
    ).toEqual({ provider: 'Together', reasoningTokens: 4096 });
  });

  it('returns undefined when OpenRouter diagnostics are absent', () => {
    expect(readOpenRouterDiagnostics({})).toBeUndefined();
    expect(
      readOpenRouterDiagnostics({ providerMetadata: { openrouter: { usage: {} } } })
    ).toBeUndefined();
  });

  it('DROPS malformed diagnostics instead of failing the turn', () => {
    // These feed run-event DISPLAY metadata — a provider label and a
    // reasoning-token count on the timeline — from inside the streaming path.
    // Throwing let a provider abort a completed turn over decoration: the same
    // bad trade that made `stealth/ox-alpha` fail instantly on a missing billed
    // cost, and worse, because that one at least guarded accounting.
    //
    // Dropped, never coerced. The timeline omits a label it cannot trust.
    expect(
      readOpenRouterDiagnostics({ providerMetadata: { openrouter: { provider: 7 } } })
    ).toBeUndefined();
    expect(
      readOpenRouterDiagnostics({
        providerMetadata: {
          openrouter: {
            usage: { completionTokensDetails: { reasoningTokens: -1 } },
          },
        },
      })
    ).toBeUndefined();
  });

  it('keeps malformed DISTINGUISHABLE where it guards accounting, not decoration', () => {
    // Diagnostics drop a malformed field to `undefined`, indistinguishable from
    // absent, because a label the timeline cannot trust is simply omitted.
    // Accounting keeps the distinction: absent is a fact about the route,
    // malformed is a broken contract the callers log at ERROR.
    expect(
      readOpenRouterBilledCost({ providerMetadata: { openrouter: { usage: { cost: -1 } } } })
    ).toMatchObject({ kind: 'malformed' });
  });
});

describe('accumulateSteppedUsage', () => {
  const freshState = (): UsageMeteringState => ({
    steppedCompletionTokens: 0,
    steppedPromptTokens: 0,
  });

  it('sums prompt and completion tokens across steps and mirrors the prompt sum', () => {
    const state = freshState();
    accumulateSteppedUsage(state, { completionTokens: 5, promptTokens: 100 });
    accumulateSteppedUsage(state, { completionTokens: 7, promptTokens: 200 });
    expect(state.steppedPromptTokens).toBe(300);
    expect(state.steppedCompletionTokens).toBe(12);
    expect(state.providerReportedPromptTokens).toBe(300);
    expect(state.latestStepPromptTokens).toBe(200);
    expect(state.latestStepCompletionTokens).toBe(7);
  });

  it('falls back to inputTokens/outputTokens field names', () => {
    const state = freshState();
    accumulateSteppedUsage(state, { inputTokens: 10, outputTokens: 3 });
    expect(state.steppedPromptTokens).toBe(10);
    expect(state.steppedCompletionTokens).toBe(3);
  });

  it('ignores absent or non-finite prompt usage without touching the reported total', () => {
    const state = freshState();
    accumulateSteppedUsage(state, undefined);
    accumulateSteppedUsage(state, { completionTokens: Number.NaN, promptTokens: Number.NaN });
    expect(state.steppedPromptTokens).toBe(0);
    expect(state.steppedCompletionTokens).toBe(0);
    expect(state.providerReportedPromptTokens).toBeUndefined();
    expect(state.latestStepPromptTokens).toBeUndefined();
    expect(state.latestStepCompletionTokens).toBeUndefined();
  });
});
