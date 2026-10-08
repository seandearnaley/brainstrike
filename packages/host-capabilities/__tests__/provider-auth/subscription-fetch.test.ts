import type { HostClientOrigin } from '@brainstrike/agent-host';
import { describe, expect, it, vi } from 'vitest';
import { createInteractiveSubscriptionFetchFactory } from '../../src/provider-auth/subscription-fetch.js';

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
    origin?: HostClientOrigin | undefined;
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
    origin: 'origin' in overrides ? overrides.origin : 'desktop-ui',
  });
}

describe('subscription fetch interactive gate', () => {
  it('FAILS CLOSED with no live client (headless, scheduled, restart recovery)', () => {
    const build = makeFactory({ origin: undefined });
    expect(() => build('openai-codex', CREDENTIAL)).toThrow(/interactive desktop/i);
  });

  it('REJECTS a public socket client even while a desktop window is open', () => {
    // Constraint 4's explicit "now or added later" case: a CLI attached to the
    // desktop's own host is refused on its OWN origin, not excused by a window.
    const build = makeFactory({ origin: 'public-socket' });
    expect(() => build('openai-codex', CREDENTIAL)).toThrow(/interactive desktop/i);
  });

  it('names the constraint in the failure so the reason is not mysterious', () => {
    const build = makeFactory({ origin: undefined });
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

  it('binds each resolution to its own origin, never a shared startup decision', () => {
    const getFreshAccessToken = async () => ({ accessToken: 'FRESH-TOKEN', ok: true as const });
    const desktop = makeFactory({ getFreshAccessToken, origin: 'desktop-ui' });
    const socket = makeFactory({ getFreshAccessToken, origin: 'public-socket' });
    expect(typeof desktop('openai-codex', CREDENTIAL)).toBe('function');
    expect(() => socket('openai-codex', CREDENTIAL)).toThrow(/interactive desktop/i);
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
