import type { OAuthProviderDescriptor, OAuthTokenGrant } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  DEFAULT_TOKEN_EXPIRES_IN_SECONDS,
  exchangeAuthorizationCode,
  toStoredOAuthCredential,
} from '../../provider-auth/oauth-flow';

function makeDescriptor(overrides: Partial<OAuthProviderDescriptor> = {}): OAuthProviderDescriptor {
  return {
    authorizeUrl: 'https://provider.test/authorize',
    clientId: 'client-123',
    extraAuthorizeParams: { audience: 'https://api.provider.test' },
    providerId: 'fake-provider',
    redirectPath: '/callback',
    redirectPort: 43_210,
    scopes: ['openid', 'offline_access'],
    tokenUrl: 'https://provider.test/token',
    ...overrides,
  };
}

describe('buildAuthorizeUrl', () => {
  it('carries client_id, redirect_uri, scope, S256 challenge, state, and extra params', () => {
    const url = new URL(
      buildAuthorizeUrl(makeDescriptor(), {
        codeChallenge: 'challenge-abc',
        redirectUri: 'http://127.0.0.1:43210/callback',
        state: 'state-xyz',
      })
    );

    expect(url.origin + url.pathname).toBe('https://provider.test/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43210/callback');
    expect(url.searchParams.get('scope')).toBe('openid offline_access');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('audience')).toBe('https://api.provider.test');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('POSTs application/x-www-form-urlencoded and parses the grant', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            expires_in: 1800,
            refresh_token: 'refresh-1',
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const grant = await exchangeAuthorizationCode({
      code: 'auth-code',
      codeVerifier: 'verifier-1',
      descriptor: makeDescriptor(),
      fetchFn,
      redirectUri: 'http://127.0.0.1:43210/callback',
    });

    expect(grant).toMatchObject({
      accessToken: 'access-1',
      expiresInSeconds: 1800,
      refreshToken: 'refresh-1',
    });

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://provider.test/token');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:43210/callback');
    expect(body.get('client_id')).toBe('client-123');
  });

  it('surfaces a non-2xx exchange as a typed token_exchange_failed error', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    ) as unknown as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        code: 'auth-code',
        codeVerifier: 'verifier-1',
        descriptor: makeDescriptor(),
        fetchFn,
        redirectUri: 'http://127.0.0.1:43210/callback',
      })
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('surfaces a 2xx response without a refresh token as token_exchange_failed', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'access-only' }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        code: 'auth-code',
        codeVerifier: 'verifier-1',
        descriptor: makeDescriptor(),
        fetchFn,
        redirectUri: 'http://127.0.0.1:43210/callback',
      })
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });
});

describe('toStoredOAuthCredential', () => {
  const grant: OAuthTokenGrant = {
    accessToken: 'access-1',
    expiresInSeconds: 1800,
    raw: {},
    refreshToken: 'refresh-1',
  };

  it('computes expires as now + expires_in * 1000', () => {
    expect(toStoredOAuthCredential(grant, { now: 1_000_000 })).toEqual({
      access: 'access-1',
      expires: 1_000_000 + 1800 * 1000,
      refresh: 'refresh-1',
      type: 'oauth',
    });
  });

  it('applies the default lifetime when the provider omits expires_in', () => {
    const { expiresInSeconds: _omitted, ...rest } = grant;
    expect(toStoredOAuthCredential(rest, { now: 0 })).toMatchObject({
      expires: DEFAULT_TOKEN_EXPIRES_IN_SECONDS * 1000,
    });
  });

  it('records the extracted account id when present', () => {
    expect(toStoredOAuthCredential(grant, { accountId: 'acct-7', now: 0 })).toMatchObject({
      accountId: 'acct-7',
    });
  });
});
