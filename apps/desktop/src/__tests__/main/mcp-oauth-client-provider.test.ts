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
    const encryptString = vi.fn((value: string) =>
      Buffer.from(`cipher:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8')
    );
    const safeStorage = {
      decryptString: (value: Buffer) =>
        Buffer.from(value.toString('utf8').replace(/^cipher:/u, ''), 'base64').toString('utf8'),
      encryptString,
      getSelectedStorageBackend: () => 'keychain',
      isEncryptionAvailable: () => true,
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
    expect(encryptString).toHaveBeenCalledWith(JSON.stringify(persisted));
    expect(JSON.stringify(Object.fromEntries(values))).not.toContain('access-secret');
    expect(JSON.stringify(Object.fromEntries(values))).not.toContain('refresh-secret');
    await expect(store.read(identity)).resolves.toEqual(persisted);

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

  it('rejects client metadata documents that are not valid HTTPS URLs', async () => {
    await expect(
      createMcpOAuthClientProvider({
        clientMetadataUrl: 'http://client.example.test/metadata.json',
        openExternal: async () => undefined,
        serverId: identity.serverId,
        serverUrl: identity.resourceUrl,
        store: createInMemoryMcpOAuthStore(),
      })
    ).rejects.toThrow('clientMetadataUrl must be a valid HTTPS URL');
  });
});
