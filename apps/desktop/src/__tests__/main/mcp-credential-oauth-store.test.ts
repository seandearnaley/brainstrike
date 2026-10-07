import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CredentialMcpOAuthStoreOptions,
  createCredentialMcpOAuthStore,
  type McpOAuthCredentialStorage,
} from '../../mcp/credential-oauth-store';
import {
  createMcpOAuthStoreIdentity,
  identityKey,
  type McpOAuthPersistedState,
  type McpOAuthStoreIdentity,
  parseRecords,
  purgeMcpOAuthRuntimeState,
  readMcpOAuthAuthProjection,
} from '../../mcp/oauth-client-provider';

const identity = createMcpOAuthStoreIdentity('fixture-server', 'https://mcp.example.test/mcp', [
  'read',
]);
const issuer = 'https://auth.example.test';

const unregisterStores = new Set<() => void>();
afterEach(() => {
  for (const unregister of unregisterStores) {
    unregister();
  }
  unregisterStores.clear();
});

function trackedStore(options: CredentialMcpOAuthStoreOptions) {
  const store = createCredentialMcpOAuthStore(options);
  unregisterStores.add(store.unregister);
  return store;
}

function fixture() {
  const values = new Map<string, string>();
  const credentials = {
    delete: vi.fn(async (account: string) => values.delete(account)),
    join: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => [...values.keys()]),
    read: vi.fn(async (account: string) => values.get(account) ?? null),
    write: vi.fn(async (account: string, value: string) => {
      values.set(account, value);
    }),
  } satisfies McpOAuthCredentialStorage;
  const accountForIdentity = (input: McpOAuthStoreIdentity): string =>
    `fixture-oauth:${identityKey(input)}`;
  const store = trackedStore({
    accountForIdentity,
    credentials,
    ownsAccount: (account) => account.startsWith('fixture-oauth:'),
    parseRecords,
  });
  return { accountForIdentity, credentials, store, values };
}

const records: Readonly<Record<string, McpOAuthPersistedState>> = {
  [issuer]: {
    clientInformation: {
      client_id: 'fixture-client',
      redirect_uris: ['http://127.0.0.1:43123/mcp'],
    },
    codeVerifier: 'fixture-verifier',
    discoveryState: { authorizationServerUrl: issuer },
    lastSuccessfulConnectionAt: 123,
    loopbackPort: 43_123,
    resourceUrl: identity.resourceUrl,
    tokens: {
      access_token: 'fixture-access',
      issuer,
      refresh_token: 'fixture-refresh',
      scope: 'read',
      token_type: 'Bearer',
    },
    updatedAt: 123,
  },
};

describe('MCP OAuth projection onto the injected credential authority', () => {
  it('preserves the shipped OAuth fields and uses the existing authorization projection', async () => {
    const { accountForIdentity, credentials, store, values } = fixture();
    await store.write(identity, records);
    expect(values.get(accountForIdentity(identity))).toBe(JSON.stringify(records));
    await expect(store.read(identity)).resolves.toEqual(records);
    expect(credentials.write).toHaveBeenCalledOnce();
    const projection = await readMcpOAuthAuthProjection(store, identity, {
      requestedScopes: ['read'],
    });
    expect(projection).toMatchObject({
      authorizationServer: issuer,
      credentialState: 'stored',
      grantedScopes: ['read'],
      requestedScopes: ['read'],
      resourceUrl: identity.resourceUrl,
      type: 'oauth-user',
    });
    expect(JSON.stringify(projection)).not.toContain('fixture-access');
    expect(JSON.stringify(projection)).not.toContain('fixture-refresh');
  });

  it('separates server, resource and scope identities while preserving canonical scope ordering', async () => {
    const { accountForIdentity, store, values } = fixture();
    await store.write(identity, records);
    const other = createMcpOAuthStoreIdentity('fixture-server', identity.resourceUrl, ['write']);
    await expect(store.read(other)).resolves.toEqual({});
    expect(accountForIdentity(other)).not.toBe(accountForIdentity(identity));
    const sorted = createMcpOAuthStoreIdentity('fixture-server', identity.resourceUrl, ['b', 'a']);
    const reordered = createMcpOAuthStoreIdentity('fixture-server', identity.resourceUrl, [
      'a',
      'b',
    ]);
    expect(accountForIdentity(sorted)).toBe(accountForIdentity(reordered));
    expect(values.size).toBe(1);
  });

  it('clears only MCP accounts and preserves provider credentials in the shared authority', async () => {
    const { accountForIdentity, credentials, store, values } = fixture();
    values.set('fixture-provider:openai', '{"type":"api_key","key":"fixture-provider-key"}');
    await store.write(identity, records);
    await store.clearAll();
    expect(values.has(accountForIdentity(identity))).toBe(false);
    expect(values.get('fixture-provider:openai')).toContain('fixture-provider-key');
    expect(credentials.delete).toHaveBeenCalledExactlyOnceWith(
      accountForIdentity(identity),
      undefined
    );
  });

  it('rejects an account mapping outside the supplied namespace before touching credentials', async () => {
    const { credentials } = fixture();
    const store = trackedStore({
      accountForIdentity: () => 'fixture-provider:openai',
      credentials,
      ownsAccount: (account) => account.startsWith('fixture-oauth:'),
      parseRecords,
    });
    await expect(store.read(identity)).rejects.toThrow('outside the configured namespace');
    expect(credentials.read).not.toHaveBeenCalled();
  });

  it('uses absence only for a missing credential and keeps a failed read visible', async () => {
    const { credentials, store } = fixture();
    await expect(store.read(identity)).resolves.toEqual({});
    const cause = new Error('fixture-credential-store-unavailable');
    credentials.read.mockRejectedValueOnce(cause);
    await expect(store.read(identity)).rejects.toBe(cause);
  });

  it.each(['{', '[]', '{"issuer":{"updatedAt":1,"loopbackPort":0}}'])(
    'preserves canonical rejection of malformed stored state %s',
    async (raw) => {
      const { accountForIdentity, store, values } = fixture();
      values.set(accountForIdentity(identity), raw);
      await expect(store.read(identity)).rejects.toThrow('persisted state is malformed');
    }
  );

  it('validates writes through the canonical parser before entering credential persistence', async () => {
    const { credentials, store } = fixture();
    const malformed = { [issuer]: { loopbackPort: 0, updatedAt: 123 } };
    await expect(store.write(identity, malformed)).rejects.toThrow('persisted state is malformed');
    expect(credentials.write).not.toHaveBeenCalled();
  });

  it('fences an already cancelled operation before reading or writing credentials', async () => {
    const { credentials, store } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(store.read(identity, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(store.write(identity, records, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(credentials.read).not.toHaveBeenCalled();
    expect(credentials.write).not.toHaveBeenCalled();
  });

  it('fences persistence when cancellation arrives during canonical validation', async () => {
    const { credentials } = fixture();
    const entered = Promise.withResolvers<void>();
    const validation = Promise.withResolvers<Readonly<Record<string, McpOAuthPersistedState>>>();
    const store = trackedStore({
      accountForIdentity: () => 'fixture-oauth:account',
      credentials,
      ownsAccount: (account) => account.startsWith('fixture-oauth:'),
      parseRecords: () => {
        entered.resolve();
        return validation.promise;
      },
    });
    const controller = new AbortController();
    const writing = store.write(identity, records, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    validation.resolve(records);
    await store.clear(identity);
    expect(credentials.write).not.toHaveBeenCalled();
  });

  it('joins a pending write before clearing its persisted record', async () => {
    const { accountForIdentity, credentials, store, values } = fixture();
    const entered = Promise.withResolvers<void>();
    const persistence = Promise.withResolvers<void>();
    credentials.write.mockImplementationOnce(async (account, raw) => {
      entered.resolve();
      await persistence.promise;
      values.set(account, raw);
    });
    const writing = store.write(identity, records);
    await entered.promise;
    const clearing = store.clear(identity);
    expect(credentials.delete).not.toHaveBeenCalled();
    persistence.resolve();
    await writing;
    await clearing;
    expect(values.has(accountForIdentity(identity))).toBe(false);
  });

  it('keeps failed writes and failed clears visible without retry', async () => {
    const { credentials, store } = fixture();
    const writeFailure = new Error('fixture-write-failed');
    credentials.write.mockRejectedValueOnce(writeFailure);
    await expect(store.write(identity, records)).rejects.toBe(writeFailure);
    expect(credentials.write).toHaveBeenCalledOnce();
    const clearFailure = new Error('fixture-clear-failed');
    credentials.delete.mockRejectedValueOnce(clearFailure);
    await expect(store.clear(identity)).rejects.toBe(clearFailure);
    expect(credentials.delete).toHaveBeenCalledOnce();
  });

  it('participates in canonical reset and joins the borrowed credential authority', async () => {
    const { accountForIdentity, credentials, store, values } = fixture();
    await store.write(identity, records);
    await store.join();
    expect(credentials.join).toHaveBeenCalledOnce();
    await purgeMcpOAuthRuntimeState();
    expect(values.has(accountForIdentity(identity))).toBe(false);
    await store.write(identity, records);
    store.unregister();
    await purgeMcpOAuthRuntimeState();
    expect(values.has(accountForIdentity(identity))).toBe(true);
  });

  it('attempts every MCP account on clearAll and reports partial cleanup failure', async () => {
    const { credentials, store, values } = fixture();
    values.set('fixture-oauth:first', '{}');
    values.set('fixture-oauth:second', '{}');
    values.set('fixture-provider:openai', 'fixture-provider-key');
    const cause = new Error('fixture-first-delete-denied');
    credentials.delete.mockRejectedValueOnce(cause);
    await expect(store.clearAll()).rejects.toMatchObject({
      errors: [cause],
      name: 'AggregateError',
    });
    expect(credentials.delete).toHaveBeenCalledTimes(2);
    expect(values.has('fixture-oauth:first')).toBe(true);
    expect(values.has('fixture-oauth:second')).toBe(false);
    expect(values.has('fixture-provider:openai')).toBe(true);
  });

  it('rejects a queued cancelled write before it can enter credentials after a pending read', async () => {
    const { credentials, store } = fixture();
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<string | null>();
    credentials.read.mockImplementationOnce(() => {
      entered.resolve();
      return reading.promise;
    });
    const first = store.read(identity);
    await entered.promise;
    const controller = new AbortController();
    const second = store.write(identity, records, controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    reading.resolve(null);
    await first;
    await store.clear(identity);
    expect(credentials.write).not.toHaveBeenCalled();
  });
});
