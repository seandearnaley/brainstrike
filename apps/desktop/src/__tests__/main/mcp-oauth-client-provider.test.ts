import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryMcpOAuthStore,
  createLazySafeStorageMcpOAuthStore,
  createMcpOAuthClientProvider,
  createSafeStorageMcpOAuthStore,
  type McpOAuthPersistedState,
  readMcpOAuthAuthProjection,
} from '../../mcp/oauth-client-provider';

const identity = {
  resourceUrl: 'https://mcp.example.test/mcp',
  scopeKey: '',
  serverId: 'linear',
} as const;

describe('MCP OAuth credential boundary', () => {
  it('requires explicit interactive consent when the authorization option is omitted', async () => {
    const openExternal = vi.fn(async () => undefined);
    const provider = await createMcpOAuthClientProvider({
      openExternal,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      const state = await provider.state?.();
      await expect(
        provider.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${state}`)
        )
      ).rejects.toMatchObject({ code: 'mcp-authentication-required' });
      expect(openExternal).not.toHaveBeenCalled();
      expect(
        provider.takePendingAuthorizationCallback(new AbortController().signal)
      ).toBeUndefined();
    } finally {
      await provider.close();
    }
  });

  it('does not initialize secure persistence before the first OAuth store operation', async () => {
    const delegate = createInMemoryMcpOAuthStore();
    const createStore = vi.fn(() => delegate);
    const store = createLazySafeStorageMcpOAuthStore(createStore);

    expect(createStore).not.toHaveBeenCalled();
    await expect(store.read(identity)).resolves.toEqual({});
    await store.clear(identity);
    expect(createStore).toHaveBeenCalledOnce();
  });

  it('retries lazy secure persistence initialization after a rejected attempt', async () => {
    const delegate = createInMemoryMcpOAuthStore();
    const createStore = vi
      .fn<() => Promise<ReturnType<typeof createInMemoryMcpOAuthStore>>>()
      .mockRejectedValueOnce(new Error('safe storage unavailable'))
      .mockResolvedValue(delegate);
    const store = createLazySafeStorageMcpOAuthStore(createStore);

    await expect(store.read(identity)).rejects.toThrow('safe storage unavailable');
    await expect(store.read(identity)).resolves.toEqual({});
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it('keeps OAuth clear joined behind pending native encryption without blocking the main lane', async () => {
    const encryption = Promise.withResolvers<Buffer>();
    const started = Promise.withResolvers<void>();
    const set = vi.fn();
    const syncAccess = vi.fn(() => {
      throw new Error('synchronous Keychain access blocks desktop main');
    });
    const storage = {
      decryptString: syncAccess,
      decryptStringAsync: async () => ({ result: '{}', shouldReEncrypt: false }),
      encryptString: syncAccess,
      encryptStringAsync: () => {
        started.resolve();
        return encryption.promise;
      },
      getSelectedStorageBackend: () => 'keychain',
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
    };
    const store = createSafeStorageMcpOAuthStore({ get: () => ({}), set }, storage);
    const writing = store.write(identity, {});
    // Observe any early failure before waiting for the actual async entry.
    writing.catch(started.reject);
    await started.promise;
    let cleared = false;
    const clearing = store.clearAll().then(() => {
      cleared = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(cleared).toBe(false);
    expect(set).not.toHaveBeenCalled();
    encryption.resolve(Buffer.from('owned-encrypted-record'));
    await writing;
    await clearing;
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith('records', {});
    expect(syncAccess).not.toHaveBeenCalled();
  });

  it('encrypts the dedicated store and refuses an insecure safeStorage backend', async () => {
    const values = new Map<string, string>();
    const electronStore = {
      get: (key: string) => (key === 'records' ? Object.fromEntries(values) : undefined),
      set: (key: string, value: unknown) => {
        if (key !== 'records' || typeof value !== 'object' || value === null) {
          throw new Error('unexpected store operation');
        }
        values.clear();
        for (const [entryKey, entryValue] of Object.entries(value)) {
          if (typeof entryValue !== 'string') {
            throw new Error('unexpected store value');
          }
          values.set(entryKey, entryValue);
        }
      },
    };
    const encryptStringAsync = vi.fn(async (value: string) =>
      Buffer.from(`cipher:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8')
    );
    const safeStorage = {
      decryptStringAsync: async (value: Buffer) => ({
        result: Buffer.from(value.toString('utf8').replace(/^cipher:/u, ''), 'base64').toString(
          'utf8'
        ),
        shouldReEncrypt: false,
      }),
      encryptStringAsync,
      getSelectedStorageBackend: () => 'keychain',
      isAsyncEncryptionAvailable: async () => true,
    };
    const store = createSafeStorageMcpOAuthStore(electronStore as never, safeStorage);
    const persisted: Readonly<Record<string, McpOAuthPersistedState>> = {
      'https://auth.example.test': {
        tokens: {
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          token_type: 'Bearer',
        },
        updatedAt: 1,
      },
    };
    await store.write(identity, persisted);
    expect(encryptStringAsync).toHaveBeenCalledWith(JSON.stringify(persisted));
    expect(JSON.stringify(Object.fromEntries(values))).not.toContain('access-secret');
    expect(JSON.stringify(Object.fromEntries(values))).not.toContain('refresh-secret');
    await expect(store.read(identity)).resolves.toEqual(persisted);

    const committed = new Map(values);
    encryptStringAsync.mockRejectedValueOnce(new Error('native encryption unavailable'));
    await expect(store.write(identity, {})).rejects.toThrow('native encryption unavailable');
    expect(values).toEqual(committed);
    await expect(store.read(identity)).resolves.toEqual(persisted);

    const unreadable = createSafeStorageMcpOAuthStore(electronStore, {
      ...safeStorage,
      decryptStringAsync: async () => {
        throw new Error('native decryption unavailable');
      },
    });
    await expect(unreadable.read(identity)).rejects.toThrow('native decryption unavailable');
    expect(values).toEqual(committed);

    const insecure = createSafeStorageMcpOAuthStore(electronStore as never, {
      ...safeStorage,
      getSelectedStorageBackend: () => 'basic_text',
    });
    await expect(insecure.write(identity, persisted)).rejects.toThrow(
      'OS-backed safeStorage encryption'
    );

    const malformed = createSafeStorageMcpOAuthStore(
      { ...electronStore, get: () => ['not', 'a', 'record'] } as never,
      safeStorage
    );
    await expect(malformed.read(identity)).rejects.toThrow('encrypted store is malformed');

    await store.write(identity, {
      issuer: { lastSuccessfulConnectionAt: 8_640_000_000_000_001, updatedAt: 1 },
    });
    await expect(store.read(identity)).rejects.toThrow('persisted state is malformed');

    await store.write(identity, { issuer: { loopbackPort: 70_000, updatedAt: 1 } });
    await expect(store.read(identity)).rejects.toThrow('persisted state is malformed');
  });

  it('partitions persisted state by configured server and canonical resource', async () => {
    const store = createInMemoryMcpOAuthStore();
    const other = {
      resourceUrl: 'https://mcp.example.test/other',
      scopeKey: '',
      serverId: 'linear',
    } as const;
    await store.write(identity, {
      issuer: {
        tokens: { access_token: 'one', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    await store.write(other, {
      issuer: {
        tokens: { access_token: 'two', token_type: 'Bearer' },
        updatedAt: 1,
      },
    });
    await expect(store.read(identity)).resolves.toMatchObject({
      issuer: { tokens: { access_token: 'one' } },
    });
    await expect(store.read(identity)).resolves.not.toMatchObject({
      issuer: { tokens: { access_token: 'two' } },
    });
  });

  it('projects only token-free auth state, scope policy, and last success', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(identity, {
      'https://auth.example.test': {
        clientInformation: { client_id: 'private-client-id', client_secret: 'private-secret' },
        discoveryState: { authorizationServerUrl: 'https://auth.example.test' },
        lastSuccessfulConnectionAt: 1234,
        tokens: {
          access_token: 'private-access',
          refresh_token: 'private-refresh',
          scope: 'read offline_access',
          token_type: 'Bearer',
        },
        updatedAt: 1234,
      },
    });

    const projection = await readMcpOAuthAuthProjection(store, identity, {
      requestedScopes: ['read'],
    });

    expect(projection).toEqual({
      authorizationServer: 'https://auth.example.test',
      credentialState: 'stored',
      grantedScopes: ['read', 'offline_access'],
      lastSuccessfulConnectionAt: 1234,
      requestedScopes: ['read'],
      resourceUrl: identity.resourceUrl,
      type: 'oauth-user',
    });
    expect(JSON.stringify(projection)).not.toMatch(
      /private-access|private-refresh|private-client-id|private-secret/u
    );
  });

  it('requests configured scopes and records successful authenticated connections', async () => {
    const store = createInMemoryMcpOAuthStore();
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      scopes: ['read'],
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    try {
      if (!(provider.saveDiscoveryState && provider.saveTokens)) {
        throw new Error('OAuth provider did not expose persistence methods.');
      }
      await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
      await provider.saveTokens(
        {
          access_token: 'private-access',
          issuer: 'https://auth.example.test',
          scope: 'read',
          token_type: 'Bearer',
        },
        { issuer: 'https://auth.example.test' }
      );
      await provider.recordSuccessfulConnection();

      expect(provider.clientMetadata.scope).toBe('read');
      expect(provider.authSnapshot()).toMatchObject({
        credentialState: 'stored',
        grantedScopes: ['read'],
        lastSuccessfulConnectionAt: expect.any(Number),
        requestedScopes: ['read'],
      });
    } finally {
      await provider.close();
    }
  });

  it('normalizes persisted dynamic-registration redirect URLs before reuse', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      const issuer = 'https://auth.example.test';
      const equivalentRedirect = provider.redirectUrl.replace('http://', 'HTTP://');
      if (!provider.saveClientInformation) {
        throw new Error('OAuth provider did not expose client-information persistence.');
      }
      await provider.saveClientInformation(
        {
          client_id: 'normalized-client',
          redirect_uris: [equivalentRedirect],
        },
        { issuer }
      );

      await expect(provider.clientInformation({ issuer })).resolves.toMatchObject({
        client_id: 'normalized-client',
      });
    } finally {
      await provider.close();
    }
  });

  it('hands each pending authorization callback to the transport exactly once', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      const state = await provider.state?.();
      if (state === undefined) {
        throw new Error('OAuth provider did not expose authorization state.');
      }
      await provider.redirectToAuthorization(
        new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(state)}`)
      );
      const controller = new AbortController();
      const callback = provider.takePendingAuthorizationCallback(controller.signal);

      expect(callback).toBeInstanceOf(Promise);
      expect(provider.takePendingAuthorizationCallback(controller.signal)).toBeUndefined();
      const callbackUrl = new URL(provider.redirectUrl);
      callbackUrl.searchParams.set('code', 'one-shot-code');
      callbackUrl.searchParams.set('state', state);
      await fetch(callbackUrl);
      await expect(callback).resolves.toEqual(
        new URLSearchParams({ code: 'one-shot-code', state })
      );
    } finally {
      await provider.close();
    }
  });

  it('cancels an aborted callback take, detaches its listener, and permits an immediate retry', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      const state = await provider.state?.();
      if (state === undefined) {
        throw new Error('OAuth provider did not expose authorization state.');
      }
      await provider.redirectToAuthorization(
        new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(state)}`)
      );
      const controller = new AbortController();
      const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
      const callback = provider.takePendingAuthorizationCallback(controller.signal);
      controller.abort();

      await expect(callback).rejects.toThrow('authorization callback was cancelled');
      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(
        provider.takePendingAuthorizationCallback(new AbortController().signal)
      ).toBeUndefined();

      const retryState = await provider.state?.();
      if (retryState === undefined) {
        throw new Error('OAuth provider did not expose retry authorization state.');
      }
      await provider.redirectToAuthorization(
        new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(retryState)}`)
      );
      const retry = provider.takePendingAuthorizationCallback(new AbortController().signal);
      const retryUrl = new URL(provider.redirectUrl);
      retryUrl.searchParams.set('code', 'retry-code');
      retryUrl.searchParams.set('state', retryState);
      await fetch(retryUrl);
      await expect(retry).resolves.toEqual(
        new URLSearchParams({ code: 'retry-code', state: retryState })
      );
    } finally {
      await provider.close();
    }
  });

  it('uses requested scopes when RFC 6749 permits the token response to omit scope', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(identity, {
      'https://auth.example.test': {
        tokens: { access_token: 'private-access', token_type: 'Bearer' },
        updatedAt: 10,
      },
    });

    await expect(
      readMcpOAuthAuthProjection(store, identity, { requestedScopes: ['read'] })
    ).resolves.toMatchObject({ grantedScopes: ['read'], requestedScopes: ['read'] });
  });

  it('prefers a token-bearing issuer record over newer discovery-only state', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(identity, {
      'https://auth-a.example.test': {
        lastSuccessfulConnectionAt: 9,
        tokens: { access_token: 'private-access', scope: 'read', token_type: 'Bearer' },
        updatedAt: 9,
      },
      'https://auth-b.example.test': {
        discoveryState: { authorizationServerUrl: 'https://auth-b.example.test' },
        updatedAt: 10,
      },
    });

    await expect(readMcpOAuthAuthProjection(store, identity)).resolves.toMatchObject({
      authorizationServer: 'https://auth-a.example.test',
      credentialState: 'stored',
      lastSuccessfulConnectionAt: 9,
    });
  });

  it('prefers the last successful token issuer over a newer unverified token record', async () => {
    const store = createInMemoryMcpOAuthStore();
    await store.write(identity, {
      'https://auth-a.example.test': {
        lastSuccessfulConnectionAt: 9,
        tokens: { access_token: 'verified-access', scope: 'read', token_type: 'Bearer' },
        updatedAt: 9,
      },
      'https://auth-b.example.test': {
        tokens: { access_token: 'unverified-access', scope: 'write', token_type: 'Bearer' },
        updatedAt: 10,
      },
    });

    await expect(readMcpOAuthAuthProjection(store, identity)).resolves.toMatchObject({
      authorizationServer: 'https://auth-a.example.test',
      grantedScopes: ['read'],
      lastSuccessfulConnectionAt: 9,
    });
  });

  it.each(['read  write', 'read\twrite', ' read', 'read '])(
    'rejects malformed granted scope %j instead of normalizing it',
    async (scope) => {
      const store = createInMemoryMcpOAuthStore();
      await store.write(identity, {
        'https://auth.example.test': {
          tokens: { access_token: 'private-access', scope, token_type: 'Bearer' },
          updatedAt: 10,
        },
      });

      await expect(readMcpOAuthAuthProjection(store, identity)).rejects.toThrow(
        'MCP OAuth granted scope is malformed'
      );
    }
  );

  it('treats an explicit empty internal scope list like an omitted list', async () => {
    const provider = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      scopes: [],
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    try {
      expect(provider.clientMetadata.scope).toBeUndefined();
      expect(provider.authSnapshot().requestedScopes).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  it('rebinds the persisted loopback port so a relaunch keeps its dynamic client registration', async () => {
    const store = createInMemoryMcpOAuthStore();
    const issuer = 'https://auth.example.test';
    const first = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    let firstRedirectUrl: string;
    try {
      firstRedirectUrl = first.redirectUrl;
      if (!first.saveClientInformation) {
        throw new Error('OAuth provider did not expose client-information persistence.');
      }
      await first.saveClientInformation(
        { client_id: 'registered-client', redirect_uris: [first.redirectUrl] },
        { issuer }
      );
    } finally {
      await first.close();
    }
    expect((await store.read(identity))[issuer]?.loopbackPort).toBe(
      Number(new URL(firstRedirectUrl).port)
    );

    const relaunched = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    try {
      expect(relaunched.redirectUrl).toBe(firstRedirectUrl);
      await expect(relaunched.clientInformation({ issuer })).resolves.toMatchObject({
        client_id: 'registered-client',
      });
      expect(relaunched.requiresReauthorization()).toBe(false);
    } finally {
      await relaunched.close();
    }
  });

  it('demands reauthorization when another process already owns the persisted loopback port', async () => {
    const store = createInMemoryMcpOAuthStore();
    const issuer = 'https://auth.example.test';
    const first = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    let takenPort: number;
    try {
      takenPort = Number(new URL(first.redirectUrl).port);
      if (!first.saveClientInformation) {
        throw new Error('OAuth provider did not expose client-information persistence.');
      }
      await first.saveClientInformation(
        { client_id: 'registered-client', redirect_uris: [first.redirectUrl] },
        { issuer }
      );
    } finally {
      await first.close();
    }

    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(takenPort, '127.0.0.1', () => resolve());
    });
    try {
      const relaunched = await createMcpOAuthClientProvider({
        allowInteractiveAuthorization: true,
        openExternal: async () => undefined,
        serverId: identity.serverId,
        serverUrl: identity.resourceUrl,
        store,
      });
      try {
        expect(Number(new URL(relaunched.redirectUrl).port)).not.toBe(takenPort);
        expect(relaunched.requiresReauthorization()).toBe(false);
        await expect(relaunched.clientInformation({ issuer })).resolves.toBeUndefined();
        expect(relaunched.requiresReauthorization()).toBe(true);
        expect((await store.read(identity))[issuer]?.clientInformation).toBeUndefined();
      } finally {
        await relaunched.close();
      }
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  /**
   * The latch outlives the replacement write on purpose: a fresh registration
   * whose authorization never completed leaves the stored grant unusable, so
   * this provider must still report that a reconnect is required. Recovery is
   * observed by the NEXT attempt's provider, which re-reads the store
   * (BST-1597 review).
   */
  it('keeps demanding reauthorization until a later provider re-reads the replacement', async () => {
    const store = createInMemoryMcpOAuthStore();
    const issuer = 'https://auth.example.test';
    await store.write(identity, {
      [issuer]: {
        clientInformation: {
          client_id: 'stale-client',
          redirect_uris: ['http://127.0.0.1:65000/mcp/oauth/callback'],
        },
        updatedAt: 1,
      },
    });
    const discarding = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    let recoveredRedirectUrl: string;
    try {
      if (!discarding.saveClientInformation) {
        throw new Error('OAuth provider did not expose client-information persistence.');
      }
      recoveredRedirectUrl = discarding.redirectUrl;
      await expect(discarding.clientInformation({ issuer })).resolves.toBeUndefined();
      expect(discarding.requiresReauthorization()).toBe(true);

      await discarding.saveClientInformation(
        { client_id: 'replacement-client', redirect_uris: [discarding.redirectUrl] },
        { issuer }
      );

      expect(discarding.requiresReauthorization()).toBe(true);
    } finally {
      await discarding.close();
    }

    const recovered = await createMcpOAuthClientProvider({
      allowInteractiveAuthorization: true,
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    try {
      expect(recovered.redirectUrl).toBe(recoveredRedirectUrl);
      await expect(recovered.clientInformation({ issuer })).resolves.toMatchObject({
        client_id: 'replacement-client',
      });
      expect(recovered.requiresReauthorization()).toBe(false);
    } finally {
      await recovered.close();
    }
  });

  it('rejects client metadata documents that are not valid HTTPS URLs', async () => {
    await expect(
      createMcpOAuthClientProvider({
        allowInteractiveAuthorization: true,
        clientMetadataUrl: 'http://client.example.test/metadata.json',
        openExternal: async () => undefined,
        serverId: identity.serverId,
        serverUrl: identity.resourceUrl,
        store: createInMemoryMcpOAuthStore(),
      })
    ).rejects.toThrow('clientMetadataUrl must be a valid HTTPS URL');
  });
});
