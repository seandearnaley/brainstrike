import type { OAuthProviderDescriptor, ProviderCredential } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOKEN_EXPIRES_IN_SECONDS } from '../../provider-auth/oauth-flow';
import { createTokenRefresher, OAUTH_REFRESH_SKEW_MS } from '../../provider-auth/refresh';
import type { SecretsService } from '../../secrets';

const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function makeDescriptor(): OAuthProviderDescriptor {
  return {
    authorizeUrl: 'https://provider.test/authorize',
    clientId: 'client-123',
    providerId: 'fake-provider',
    redirectPath: '/callback',
    redirectPort: 43_210,
    scopes: ['openid'],
    tokenUrl: 'https://provider.test/token',
  };
}

function makeSecrets(initial: Record<string, ProviderCredential> = {}): SecretsService & {
  readonly store: Map<string, ProviderCredential>;
} {
  const store = new Map<string, ProviderCredential>(Object.entries(initial));
  return {
    clearAll: async () => {
      store.clear();
      return true;
    },
    deleteKey: async (provider) => store.delete(provider),
    getCredential: async (provider) => store.get(provider) ?? null,
    getKey: async () => null,
    listProviders: async () => [...store.keys()],
    saveKey: async () => true,
    setCredential: async (provider, credential) => {
      store.set(provider, credential);
      return true;
    },
    store,
  };
}

function oauthCredential(expires: number): ProviderCredential {
  return { access: 'old-access', expires, refresh: 'old-refresh', type: 'oauth' };
}

interface RefresherSetup {
  fetchFn: ReturnType<typeof vi.fn>;
  responses: Response[];
}

function makeFetch(setup: RefresherSetup['responses']): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => {
    const response = setup[index];
    index += 1;
    if (!response) {
      throw new Error('fetch exhausted');
    }
    return response;
  });
}

function refreshedResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'new-access',
      expires_in: 3600,
      refresh_token: 'new-refresh',
      ...overrides,
    }),
    { status: 200 }
  );
}

describe('createTokenRefresher', () => {
  it('single-flights a stalled body until the request deadline, without rotating credentials', async () => {
    vi.useFakeTimers();
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    let bodyStarted: (() => void) | undefined;
    const reachedBody = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            bodyStarted?.();
            return await new Promise<string>(() => undefined);
          },
        }) as Response
    );
    const refresher = createTokenRefresher({
      fetchFn,
      fetchTimeoutMs: 100,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });
    const first = refresher.getFreshAccessToken('fake-provider');
    const second = refresher.getFreshAccessToken('fake-provider');
    await reachedBody;
    const firstFailure = expect(first).rejects.toMatchObject({ code: 'token_exchange_failed' });
    const secondFailure = expect(second).rejects.toMatchObject({ code: 'token_exchange_failed' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([firstFailure, secondFailure]);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(secrets.store.get('fake-provider')).toEqual(oauthCredential(NOW));
  });

  it('returns the stored access token untouched when outside the skew window', async () => {
    const secrets = makeSecrets({
      'fake-provider': oauthCredential(NOW + OAUTH_REFRESH_SKEW_MS + 60_000),
    });
    const fetchFn = makeFetch([]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      accessToken: 'old-access',
      ok: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes inside the skew window and persists the rotated pair', async () => {
    const secrets = makeSecrets({
      'fake-provider': oauthCredential(NOW + OAUTH_REFRESH_SKEW_MS - 1),
    });
    const fetchFn = makeFetch([refreshedResponse()]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      accessToken: 'new-access',
      ok: true,
    });
    expect(secrets.store.get('fake-provider')).toEqual({
      access: 'new-access',
      expires: NOW + 3600 * 1000,
      refresh: 'new-refresh',
      type: 'oauth',
    });

    const body = new URLSearchParams(
      String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBe('client-123');
  });

  it('keeps the previous refresh token when the response omits one (RFC 6749 optional rotation)', async () => {
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    const fetchFn = makeFetch([refreshedResponse({ refresh_token: undefined })]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await refresher.getFreshAccessToken('fake-provider');
    expect(secrets.store.get('fake-provider')).toMatchObject({ refresh: 'old-refresh' });
  });

  it('preserves the stored accountId across refreshes', async () => {
    const secrets = makeSecrets({
      'fake-provider': {
        access: 'old-access',
        accountId: 'acct-1',
        expires: NOW,
        refresh: 'old-refresh',
        type: 'oauth',
      },
    });
    const fetchFn = makeFetch([refreshedResponse()]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await refresher.getFreshAccessToken('fake-provider');
    expect(secrets.store.get('fake-provider')).toMatchObject({ accountId: 'acct-1' });
  });

  it('single-flights concurrent refreshes onto ONE network call', async () => {
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(async () => {
      await gate;
      return refreshedResponse();
    });
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    const first = refresher.getFreshAccessToken('fake-provider');
    const second = refresher.getFreshAccessToken('fake-provider');
    release?.();

    await expect(first).resolves.toEqual({ accessToken: 'new-access', ok: true });
    await expect(second).resolves.toEqual({ accessToken: 'new-access', ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh refresh after the in-flight one settles', async () => {
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    // Second refresh needed because the first response expires immediately.
    const fetchFn = makeFetch([refreshedResponse({ expires_in: 1 }), refreshedResponse()]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await refresher.getFreshAccessToken('fake-provider');
    await refresher.getFreshAccessToken('fake-provider');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('maps invalid_grant to reconnect_required, keeps the credential, and never retries', async () => {
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    const fetchFn = makeFetch([
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ]);
    const onReconnectRequired = vi.fn();
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      onReconnectRequired,
      secrets,
    });

    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      ok: false,
      status: 'reconnect_required',
    });
    // Never delete silently: the credential stays until the user disconnects
    // or reconnects.
    expect(secrets.store.get('fake-provider')).toEqual(oauthCredential(NOW));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onReconnectRequired).toHaveBeenCalledWith('fake-provider');
  });

  it('throws a typed error on other refresh failures without retrying', async () => {
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    const fetchFn = makeFetch([new Response('upstream broke', { status: 503 })]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await expect(refresher.getFreshAccessToken('fake-provider')).rejects.toMatchObject({
      code: 'token_exchange_failed',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('applies the shared default token lifetime when the refresh response omits expires_in', async () => {
    // Security-review finding 10: one shared constant, not a magic 3600.
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    const fetchFn = makeFetch([refreshedResponse({ expires_in: undefined })]);
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await refresher.getFreshAccessToken('fake-provider');
    expect(secrets.store.get('fake-provider')).toMatchObject({
      expires: NOW + DEFAULT_TOKEN_EXPIRES_IN_SECONDS * 1000,
    });
  });

  it('passes an abort signal to the refresh fetch (timeout guard)', async () => {
    // Security-review finding 4: no fetch may hang forever.
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    let observedSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      observedSignal = init?.signal;
      return refreshedResponse();
    });
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await refresher.getFreshAccessToken('fake-provider');
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it('holds a rotated pair IN MEMORY when persistence fails: session keeps working, next refresh uses the rotated token', async () => {
    // Security-review finding 3: the provider consumed the old refresh token
    // the moment rotation succeeded — losing the rotated pair to a store
    // write failure would strand the session. Hold it in memory for the
    // process lifetime and tell the engine persistence failed.
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    const original = secrets.setCredential;
    let failPersist = true;
    secrets.setCredential = async (provider, credential) => {
      if (failPersist) {
        throw new Error('keychain unavailable');
      }
      return original(provider, credential);
    };
    const fetchFn = makeFetch([
      refreshedResponse({ expires_in: 1 }), // rotated pair; persist fails
      refreshedResponse({
        access_token: 'newer-access',
        expires_in: 3600,
        refresh_token: 'newer-refresh',
      }),
    ]);
    const onPersistFailure = vi.fn();
    const onPersistRecovered = vi.fn();
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      onPersistFailure,
      onPersistRecovered,
      secrets,
    });

    // First refresh: network rotation succeeds, persist fails -> still ok.
    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      accessToken: 'new-access',
      ok: true,
    });
    expect(onPersistFailure).toHaveBeenCalledWith('fake-provider');
    // The store still holds the OLD credential (nothing deleted or corrupted).
    expect(secrets.store.get('fake-provider')).toEqual(oauthCredential(NOW));

    // Second refresh (in-memory pair already expired): must present the
    // ROTATED refresh token, not the stale stored one.
    failPersist = false;
    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      accessToken: 'newer-access',
      ok: true,
    });
    const secondBody = new URLSearchParams(
      String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body)
    );
    expect(secondBody.get('refresh_token')).toBe('new-refresh');
    // Store recovered: the newest pair is persisted and the overlay cleared.
    expect(onPersistRecovered).toHaveBeenCalledWith('fake-provider');
    expect(secrets.store.get('fake-provider')).toMatchObject({
      access: 'newer-access',
      refresh: 'newer-refresh',
    });
  });

  it('discards a refresh that completes under a stale epoch: no persist, no overlay (disconnect race)', async () => {
    // Security-review finding 5.
    const secrets = makeSecrets({ 'fake-provider': oauthCredential(NOW) });
    let epoch = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(async () => {
      await gate;
      return refreshedResponse();
    });
    const setCredentialSpy = vi.spyOn(secrets, 'setCredential');
    const refresher = createTokenRefresher({
      fetchFn: fetchFn as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      getEpoch: () => epoch,
      now: () => NOW,
      secrets,
    });

    const refreshing = refresher.getFreshAccessToken('fake-provider');
    // Bump the epoch only once the refresh network call is actually in
    // flight — that is the disconnect-mid-refresh interleaving under test.
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
    epoch = 1; // disconnect happened mid-flight
    release?.();

    await expect(refreshing).resolves.toEqual({ ok: false, status: 'not_connected' });
    expect(setCredentialSpy).not.toHaveBeenCalled();
  });

  it('reports not_connected when nothing (or a non-oauth credential) is stored', async () => {
    const secrets = makeSecrets({
      'other-provider': { key: 'sk-123', type: 'api_key' },
    });
    const refresher = createTokenRefresher({
      fetchFn: makeFetch([]) as unknown as typeof fetch,
      getDescriptor: makeDescriptor,
      now: () => NOW,
      secrets,
    });

    await expect(refresher.getFreshAccessToken('fake-provider')).resolves.toEqual({
      ok: false,
      status: 'not_connected',
    });
    await expect(refresher.getFreshAccessToken('other-provider')).resolves.toEqual({
      ok: false,
      status: 'not_connected',
    });
  });
});
