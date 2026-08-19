import type { OAuthProviderDescriptor, OAuthTokenGrant } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { ProviderAuthFlowCancelledError } from '../../provider-auth/errors';
import {
  buildAuthorizeUrl,
  DEFAULT_TOKEN_EXPIRES_IN_SECONDS,
  exchangeAuthorizationCode,
  type OAuthFlowDeps,
  runLoopbackOAuthFlow,
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

  it('surfaces a 2xx response without a refresh token as the DISTINCT refresh_token_missing code', async () => {
    // Security-review finding 7: this is almost always a scope problem
    // (missing offline_access-style scope), not a generic exchange failure —
    // the code and message must say so.
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'access-only' }), { status: 200 })
    ) as unknown as typeof fetch;

    const attempt = exchangeAuthorizationCode({
      code: 'auth-code',
      codeVerifier: 'verifier-1',
      descriptor: makeDescriptor(),
      fetchFn,
      redirectUri: 'http://127.0.0.1:43210/callback',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'refresh_token_missing' });
    await expect(attempt).rejects.toThrow(/scope/i);
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

describe('runLoopbackOAuthFlow cancellation during server startup (PR #2529 finding 2)', () => {
  it('honours a cancel that fires while startLoopbackServerFn is still pending', async () => {
    // The abort listener used to be attached only AFTER `await startServer`.
    // Aborting during startup therefore armed a signal that had ALREADY
    // fired, so `addEventListener('abort', …)` never invoked the handler: the
    // flow opened the browser anyway and sat on the callback wait until the
    // 5-minute timeout, with engine.cancel() blocked behind it the whole time.
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const openExternal = vi.fn(async () => undefined);
    let releaseStartup: (() => void) | undefined;
    const startedUp = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });

    const attempt = runLoopbackOAuthFlow(makeDescriptor(), {
      cancelSignal: controller.signal,
      fetchFn: vi.fn() as unknown as typeof fetch,
      openExternal,
      secrets: {
        deleteKey: vi.fn(),
        getCredential: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        setCredential: vi.fn(),
        setKey: vi.fn(),
      } as unknown as OAuthFlowDeps['secrets'],
      startLoopbackServerFn: async () => {
        await startedUp;
        return {
          cancel,
          close,
          port: 43_210,
          redirectUri: 'http://127.0.0.1:43210/callback',
          // A callback that never arrives: only the cancellation path can
          // settle this flow.
          waitForCallback: () => new Promise<never>(() => undefined),
        };
      },
    });

    controller.abort();
    releaseStartup?.();

    await expect(attempt).rejects.toBeInstanceOf(ProviderAuthFlowCancelledError);
    // Cancelling means the user never wanted the browser opened.
    expect(openExternal).not.toHaveBeenCalled();
    // The listening socket must not outlive the flow.
    expect(close).toHaveBeenCalledTimes(1);
  });
});
