import { describe, expect, it, vi } from 'vitest';
import { createInteractiveSubscriptionFetchFactory } from '../../provider-auth/subscription-fetch';

/**
 * Interactive-desktop-only enforcement at the credential-resolution layer —
 * BST-1356, legal gate BST-1351 constraint 4:
 *
 * > the `openai-codex` provider is resolvable only in interactive desktop
 * > sessions — it must be structurally unavailable to any scheduled,
 * > headless, server, or multi-user execution context, now or added later
 * > (enforce at the credential-resolution layer with a test, so a future
 * > headless mode fails closed for this provider).
 *
 * This is the test that clause asks for.
 */

const CREDENTIAL = {
  access: 'access-token',
  accountId: 'acct-7',
  expires: Date.now() + 3_600_000,
  refresh: 'refresh-token',
  source: 'stored',
  type: 'oauth',
} as const;

function makeFactory(
  overrides: {
    resolveOriginRole?: () => string | undefined;
    getFreshAccessToken?: (
      providerId: string
    ) => Promise<
      | { accessToken: string; ok: true }
      | { ok: false; status: 'not_connected' | 'reconnect_required' }
    >;
  } = {}
) {
  return createInteractiveSubscriptionFetchFactory({
    appVersion: '9.9.9',
    getFreshAccessToken:
      overrides.getFreshAccessToken ??
      (async () => ({ accessToken: 'FRESH-TOKEN', ok: true as const })),
    resolveOriginRole: overrides.resolveOriginRole ?? (() => 'visible-ui'),
  });
}

describe('subscription fetch interactive gate', () => {
  it('FAILS CLOSED when no origin holds the assistant token (headless/scheduled)', () => {
    const build = makeFactory({ resolveOriginRole: () => undefined });
    expect(() => build('openai-codex', CREDENTIAL)).toThrow(/interactive desktop/i);
  });

  it('REJECTS a non-visible-ui origin even while a window is open', () => {
    // Constraint 4's explicit "now or added later" case: a hidden host or a
    // future background mode reaching this path is refused on its OWN role,
    // not excused by some other window being open.
    for (const role of ['llm-host', 'embedding-host', 'chunking-host', 'hidden-host']) {
      const build = makeFactory({ resolveOriginRole: () => role });
      expect(() => build('openai-codex', CREDENTIAL), role).toThrow(/interactive desktop/i);
    }
  });

  it('names the constraint in the failure so the reason is not mysterious', () => {
    const build = makeFactory({ resolveOriginRole: () => undefined });
    expect(() => build('openai-codex', CREDENTIAL)).toThrow(
      /structurally unavailable to non-interactive contexts/i
    );
  });

  it('builds a fetch when an interactive window is present', () => {
    const build = makeFactory();
    expect(typeof build('openai-codex', CREDENTIAL)).toBe('function');
  });

  it('refuses to mint a subscription fetch for any other provider', () => {
    const build = makeFactory();
    expect(() => build('openai', CREDENTIAL)).toThrow(/openai-codex/);
  });

  it('re-resolves the origin per credential resolution, not once at startup', () => {
    let role: string | undefined = 'visible-ui';
    const build = makeFactory({ resolveOriginRole: () => role });
    expect(typeof build('openai-codex', CREDENTIAL)).toBe('function');
    // The holder went away; the very next resolution must fail closed rather
    // than ride a stale startup-time decision.
    role = undefined;
    expect(() => build('openai-codex', CREDENTIAL)).toThrow(/interactive desktop/i);
  });
});

describe('subscription fetch token acquisition', () => {
  it('routes token reads through the engine single-flight refresher', async () => {
    const getFreshAccessToken = vi.fn(async () => ({
      accessToken: 'FRESH-TOKEN',
      ok: true as const,
    }));
    const baseFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const build = makeFactory({ getFreshAccessToken });
      const codexFetch = build('openai-codex', CREDENTIAL);
      await codexFetch('https://api.openai.com/v1/responses', {
        body: JSON.stringify({ model: 'gpt-5.5' }),
        method: 'POST',
      });
    } finally {
      baseFetch.mockRestore();
    }
    expect(getFreshAccessToken).toHaveBeenCalledWith('openai-codex');
  });

  it('surfaces reconnect_required as a visible failure, never an unauthenticated send', async () => {
    const build = makeFactory({
      getFreshAccessToken: async () => ({ ok: false as const, status: 'reconnect_required' }),
    });
    const codexFetch = build('openai-codex', CREDENTIAL);
    const baseFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await expect(
        codexFetch('https://api.openai.com/v1/responses', {
          body: JSON.stringify({ model: 'gpt-5.5' }),
          method: 'POST',
        })
      ).rejects.toThrow(/reconnect/i);
      expect(baseFetch).not.toHaveBeenCalled();
    } finally {
      baseFetch.mockRestore();
    }
  });

  it('surfaces not_connected distinctly', async () => {
    const build = makeFactory({
      getFreshAccessToken: async () => ({ ok: false as const, status: 'not_connected' }),
    });
    const codexFetch = build('openai-codex', CREDENTIAL);
    await expect(
      codexFetch('https://api.openai.com/v1/responses', {
        body: JSON.stringify({ model: 'gpt-5.5' }),
        method: 'POST',
      })
    ).rejects.toThrow(/not connected|connect/i);
  });

  it('never puts token material in the thrown message', async () => {
    const build = makeFactory({
      getFreshAccessToken: async () => ({ ok: false as const, status: 'reconnect_required' }),
    });
    const codexFetch = build('openai-codex', CREDENTIAL);
    let thrown: unknown;
    try {
      await codexFetch('https://api.openai.com/v1/responses', {
        body: JSON.stringify({ model: 'gpt-5.5' }),
        method: 'POST',
      });
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain('access-token');
    expect(message).not.toContain('refresh-token');
  });
});
