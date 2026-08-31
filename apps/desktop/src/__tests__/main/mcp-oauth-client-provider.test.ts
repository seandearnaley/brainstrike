import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
  createSafeStorageMcpOAuthStore,
  type McpOAuthPersistedState,
} from '../../mcp/oauth-client-provider';

const identity = { resourceUrl: 'https://mcp.example.test/mcp', serverId: 'linear' } as const;

describe('MCP OAuth credential boundary', () => {
  let provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>> | undefined;

  afterEach(async () => {
    await provider?.close();
    provider = undefined;
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
  });

  it('keeps OAuth material inside main-process state and clears it on disconnect', async () => {
    const store = createInMemoryMcpOAuthStore();
    provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store,
    });
    if (!(provider.saveDiscoveryState && provider.saveTokens)) {
      throw new Error('OAuth provider did not expose persistence methods.');
    }
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.test' });
    await provider.saveTokens(
      {
        access_token: 'access-secret',
        issuer: 'https://auth.example.test',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
      },
      { issuer: 'https://auth.example.test' }
    );

    expect(JSON.stringify(provider)).not.toContain('access-secret');
    expect(JSON.stringify(provider)).not.toContain('refresh-secret');
    await provider.disconnect();
    await expect(provider.tokens({ issuer: 'https://auth.example.test' })).resolves.toBeUndefined();
    await expect(store.read(identity)).resolves.toEqual({});
  });

  it('makes cancellation terminal, closes the callback listener, and rejects stale credential saves', async () => {
    provider = await createMcpOAuthClientProvider({
      openExternal: async () => undefined,
      serverId: identity.serverId,
      serverUrl: identity.resourceUrl,
      store: createInMemoryMcpOAuthStore(),
    });
    const callbackUrl = provider.redirectUrl;
    await provider.cancel();

    await expect(fetch(callbackUrl)).rejects.toThrow();
    if (!provider.saveTokens) {
      throw new Error('OAuth provider did not expose token persistence.');
    }
    await expect(
      provider.saveTokens(
        { access_token: 'stale-token', token_type: 'Bearer' },
        { issuer: 'https://auth.example.test' }
      )
    ).rejects.toThrow('provider is closed');
  });

  it('partitions persisted state by configured server and canonical resource', async () => {
    const store = createInMemoryMcpOAuthStore();
    const other = { resourceUrl: 'https://mcp.example.test/other', serverId: 'linear' } as const;
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
