import { describe, expect, it, vi } from 'vitest';
import type { ResolvedProviderCredential } from '../ports.js';
import {
  OAUTH_SUBSCRIPTION_DUMMY_KEY,
  providerAuthInputFromCredential,
  UnsupportedCredentialTypeError,
} from '../provider-credential-projection.js';

/**
 * Interactive-desktop-only enforcement for subscription OAuth — BST-1356,
 * legal gate BST-1351 constraint 4.
 *
 * The enforcement is STRUCTURAL, not a flag: minting a subscription auth
 * input requires an injected `oauthSubscriptionFetch` capability. Only the
 * interactive desktop assistant-server supplies one. Web, headless, scheduled
 * and any future non-interactive host supply nothing and therefore CANNOT
 * resolve the credential — they fail closed with a typed error, exactly the
 * way `profile_chain` already fails closed on web (BST-1353 precedent).
 */

const OAUTH_CREDENTIAL: ResolvedProviderCredential = {
  access: 'access-token',
  accountId: 'acct-1',
  expires: Date.now() + 3_600_000,
  refresh: 'refresh-token',
  source: 'stored',
  type: 'oauth',
};

describe('oauth_subscription projection without the interactive capability', () => {
  it('REFUSES to resolve when no capability is injected (web/headless fail closed)', () => {
    expect(() => providerAuthInputFromCredential('openai-codex', OAUTH_CREDENTIAL)).toThrow(
      UnsupportedCredentialTypeError
    );
  });

  it('explains that the desktop app is required, without echoing token material', () => {
    let thrown: unknown;
    try {
      providerAuthInputFromCredential('openai-codex', OAUTH_CREDENTIAL);
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toMatch(/desktop app/i);
    expect(message).not.toContain('access-token');
    expect(message).not.toContain('refresh-token');
  });

  it('keeps the SecretReadError shape so existing responders classify it', () => {
    try {
      providerAuthInputFromCredential('openai-codex', OAUTH_CREDENTIAL);
      expect.unreachable('expected a typed rejection');
    } catch (error) {
      expect((error as Error).name).toBe('SecretReadError');
      expect((error as UnsupportedCredentialTypeError).code).toBe('credential_type_unsupported');
      expect((error as UnsupportedCredentialTypeError).provider).toBe('openai-codex');
    }
  });
});

describe('oauth_subscription projection with the interactive capability', () => {
  it('mints a custom_fetch input carrying the injected closure', () => {
    const subscriptionFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const build = vi.fn(() => subscriptionFetch);

    const input = providerAuthInputFromCredential('openai-codex', OAUTH_CREDENTIAL, {
      oauthSubscriptionFetch: build,
    });

    expect(input).toEqual({
      apiKey: OAUTH_SUBSCRIPTION_DUMMY_KEY,
      fetch: subscriptionFetch,
      kind: 'custom_fetch',
    });
    expect(build).toHaveBeenCalledWith('openai-codex', OAUTH_CREDENTIAL);
  });

  it('never puts real token material in the apiKey the SDK sees', () => {
    const input = providerAuthInputFromCredential('openai-codex', OAUTH_CREDENTIAL, {
      oauthSubscriptionFetch: () => vi.fn() as unknown as typeof globalThis.fetch,
    });
    expect(input?.apiKey).not.toContain('access-token');
    expect(input?.apiKey).not.toContain('refresh-token');
    expect(OAUTH_SUBSCRIPTION_DUMMY_KEY.length).toBeGreaterThan(0);
  });

  it('rejects an oauth credential on a provider that is not oauth_subscription', () => {
    // A stored oauth credential under e.g. `anthropic` is a credential/provider
    // mismatch — minting a subscription fetch for it would be a confusion.
    expect(() =>
      providerAuthInputFromCredential('anthropic', OAUTH_CREDENTIAL, {
        oauthSubscriptionFetch: () => vi.fn() as unknown as typeof globalThis.fetch,
      })
    ).toThrow(UnsupportedCredentialTypeError);
  });

  it('still rejects an api_key credential stored under the subscription provider', () => {
    // The subscription provider has no API-key mode; accepting one would send
    // a metered platform key to the subscription backend.
    expect(() =>
      providerAuthInputFromCredential(
        'openai-codex',
        { key: 'sk-live', source: 'stored', type: 'api_key' },
        { oauthSubscriptionFetch: () => vi.fn() as unknown as typeof globalThis.fetch }
      )
    ).toThrow(UnsupportedCredentialTypeError);
  });
});
