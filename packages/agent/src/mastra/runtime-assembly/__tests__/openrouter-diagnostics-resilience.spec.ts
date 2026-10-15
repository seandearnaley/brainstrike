import { describe, expect, it } from 'vitest';
import { readOpenRouterDiagnostics } from '../../../usage-metering';

/**
 * Display metadata must never be able to kill a turn.
 *
 * `readOpenRouterDiagnostics` feeds run-event metadata — the provider name and
 * a reasoning-token count shown on the timeline. It runs inside the streaming
 * path and THREW on any malformed field, so a provider that sent a wrong-typed
 * decoration would abort a completed turn.
 *
 * Same bug class as the billed-cost throw (`stealth/ox-alpha` failing instantly
 * because an anonymous route reports no cost), but with a worse trade: that one
 * at least guarded accounting, this one guards a label.
 */
const part = (openrouter: unknown) => ({ providerMetadata: { openrouter } }) as never;

describe('readOpenRouterDiagnostics never throws on malformed decoration', () => {
  it('drops a malformed provider name instead of failing the turn', () => {
    expect(readOpenRouterDiagnostics(part({ provider: 42 }))).toBeUndefined();
  });

  it('drops a blank provider name', () => {
    expect(readOpenRouterDiagnostics(part({ provider: '   ' }))).toBeUndefined();
  });

  it('drops malformed usage metadata', () => {
    expect(readOpenRouterDiagnostics(part({ usage: 'nope' }))).toBeUndefined();
  });

  it('drops malformed completion-token details', () => {
    expect(
      readOpenRouterDiagnostics(part({ usage: { completionTokensDetails: 'nope' } }))
    ).toBeUndefined();
  });

  it('drops a malformed reasoning-token count', () => {
    expect(
      readOpenRouterDiagnostics(
        part({ usage: { completionTokensDetails: { reasoningTokens: -3 } } })
      )
    ).toBeUndefined();
  });

  it('KEEPS the good fields when one sibling is malformed', () => {
    // Partial corruption must not discard usable diagnostics.
    const result = readOpenRouterDiagnostics(
      part({
        provider: 'Anthropic',
        usage: { completionTokensDetails: { reasoningTokens: -1 } },
      })
    );
    expect(result?.provider).toBe('Anthropic');
    expect(result?.reasoningTokens).toBeUndefined();
  });

  it('still reads well-formed diagnostics unchanged', () => {
    const result = readOpenRouterDiagnostics(
      part({ provider: 'Fireworks', usage: { completionTokensDetails: { reasoningTokens: 12 } } })
    );
    expect(result).toEqual({ provider: 'Fireworks', reasoningTokens: 12 });
  });
});
