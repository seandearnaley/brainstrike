import { describe, expect, it } from 'vitest';

import { readOpenRouterBilledCost } from '../usage-metering';

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
