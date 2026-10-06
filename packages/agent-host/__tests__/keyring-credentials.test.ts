import { getEventListeners } from 'node:events';
import { parseStoredCredential } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialStoreClosedError,
  CredentialStoreUnavailableError,
  type KeyringCredentialBackend,
  type KeyringEntryRequest,
  type KeyringNativeEntry,
} from '../src/adapters/credential-contract.js';
import { createKeyringCredentialStore } from '../src/adapters/keyring-credentials.js';

function fixture() {
  const values = new Map<string, string>();
  const requests: KeyringEntryRequest[] = [];
  const close = vi.fn(async () => undefined);
  const createEntry = vi.fn(async (request: KeyringEntryRequest): Promise<KeyringNativeEntry> => {
    requests.push(request);
    return {
      deleteCredential: async () => values.delete(request.account),
      getPassword: async () => values.get(request.account),
      setPassword: async (value) => {
        values.set(request.account, value);
      },
    };
  });
  const listAccounts = vi.fn(async () => [...values.keys()]);
  const backend = { close, createEntry, listAccounts } satisfies KeyringCredentialBackend;
  const store = createKeyringCredentialStore({ backend, service: 'fixture-profile-only' });
  return { backend, requests, store, values };
}

describe('injected keyring credential authority', () => {
  it('requires the profile service and supplies explicit Secret Service selection', async () => {
    const { backend, requests, store } = fixture();
    expect(() => createKeyringCredentialStore({ backend, service: '' })).toThrow(TypeError);
    await store.write('fixture-provider', '{"type":"api_key","key":"fixture-key"}');
    expect(requests).toEqual([
      {
        account: 'fixture-provider',
        options: { linux: { store: 'secret-service' } },
        service: 'fixture-profile-only',
      },
    ]);
    await store.close();
  });

  it('preserves typed credentials and the shared legacy interpretation without a token cache', async () => {
    const { store, values } = fixture();
    const credential = { key: 'fixture-key', type: 'api_key' } as const;
    await store.write('fixture-provider', JSON.stringify(credential));
    expect(parseStoredCredential((await store.read('fixture-provider')) as string)).toEqual(
      credential
    );
    values.set('fixture-provider', 'fixture-legacy-key');
    expect(parseStoredCredential((await store.read('fixture-provider')) as string)).toEqual({
      key: 'fixture-legacy-key',
      type: 'api_key',
    });
    await store.close();
  });

  it('returns absence only for native absence and deletion only for native deletion', async () => {
    const { store } = fixture();
    await expect(store.read('absent')).resolves.toBeNull();
    await expect(store.delete('absent')).resolves.toBe(false);
    await store.write('present', 'fixture-value');
    await expect(store.delete('present')).resolves.toBe(true);
    await expect(store.read('present')).resolves.toBeNull();
    await store.close();
  });

  it('keeps backend construction failure visible without retrying or selecting another backend', async () => {
    const { backend, store } = fixture();
    const cause = new Error('fixture-unavailable-backend');
    backend.createEntry.mockRejectedValueOnce(cause);
    await expect(store.read('fixture-provider')).rejects.toMatchObject({
      cause,
      code: 'credential_store_unavailable',
      operation: 'read',
    });
    expect(backend.createEntry).toHaveBeenCalledOnce();
    expect(store.completion().pendingNativeOperations).toBe(0);
    await store.close();
  });

  it('does not turn unreadable, undeletable, or unlistable storage into absence', async () => {
    const { backend, store } = fixture();
    backend.createEntry.mockResolvedValue({
      deleteCredential: async () => {
        throw new Error('fixture-delete-denied');
      },
      getPassword: async () => {
        throw new Error('fixture-read-denied');
      },
      setPassword: async () => undefined,
    });
    backend.listAccounts.mockRejectedValueOnce(new Error('fixture-list-denied'));
    await expect(store.read('fixture-provider')).rejects.toBeInstanceOf(
      CredentialStoreUnavailableError
    );
    await expect(store.delete('fixture-provider')).rejects.toBeInstanceOf(
      CredentialStoreUnavailableError
    );
    await expect(store.listAccounts()).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    await store.close();
  });

  it('rejects an already cancelled operation before entering native storage', async () => {
    const { backend, store } = fixture();
    const controller = new AbortController();
    const reason = new Error('fixture-cancelled');
    controller.abort(reason);
    await expect(store.write('fixture-provider', 'fixture-value', controller.signal)).rejects.toBe(
      reason
    );
    expect(backend.createEntry).not.toHaveBeenCalled();
    expect(store.completion()).toEqual({
      pendingNativeOperations: 0,
      queuedOperations: 0,
      state: 'open',
    });
    await store.close();
  });

  it('fences a queued cancelled write while retaining the operation in front of it', async () => {
    const { backend, store, values } = fixture();
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<string | undefined>();
    backend.createEntry.mockResolvedValueOnce({
      deleteCredential: async () => false,
      getPassword: () => {
        entered.resolve();
        return reading.promise;
      },
      setPassword: async () => undefined,
    });
    const first = store.read('first');
    await entered.promise;
    const controller = new AbortController();
    const queued = store.write('second', 'fixture-value', controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.createEntry).toHaveBeenCalledOnce();
    expect(store.completion().pendingNativeOperations).toBe(1);
    reading.resolve('fixture-first');
    await first;
    await store.close();
    expect(values.has('second')).toBe(false);
    expect(backend.createEntry).toHaveBeenCalledOnce();
  });

  it('rejects caller cancellation promptly but joins actual native work before closing', async () => {
    const { backend, store } = fixture();
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<string | undefined>();
    backend.createEntry.mockResolvedValueOnce({
      deleteCredential: async () => false,
      getPassword: (...args) => {
        expect(args).toEqual([]);
        entered.resolve();
        return reading.promise;
      },
      setPassword: async () => undefined,
    });
    const controller = new AbortController();
    const caller = store.read('fixture-provider', controller.signal);
    await entered.promise;
    controller.abort();
    await expect(caller).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(store.completion()).toEqual({
      pendingNativeOperations: 1,
      queuedOperations: 0,
      state: 'open',
    });
    const closing = store.close();
    expect(store.close()).toBe(closing);
    expect(store.completion().state).toBe('closing');
    expect(backend.close).not.toHaveBeenCalled();
    await expect(store.read('next')).rejects.toBeInstanceOf(CredentialStoreClosedError);
    reading.resolve('fixture-private-value');
    await expect(closing).resolves.toEqual({ pendingNativeOperations: 0 });
    expect(backend.close).toHaveBeenCalledOnce();
    expect(store.completion()).toEqual({
      pendingNativeOperations: 0,
      queuedOperations: 0,
      state: 'closed',
    });
  });

  it('joins cancelled native construction and fences the subsequent mutation', async () => {
    const { backend, store } = fixture();
    const entered = Promise.withResolvers<void>();
    const construction = Promise.withResolvers<KeyringNativeEntry>();
    const setPassword = vi.fn(async () => undefined);
    backend.createEntry.mockImplementationOnce(() => {
      entered.resolve();
      return construction.promise;
    });
    const controller = new AbortController();
    const caller = store.write('fixture-provider', 'fixture-value', controller.signal);
    await entered.promise;
    controller.abort();
    await expect(caller).rejects.toMatchObject({ name: 'AbortError' });
    const closing = store.close();
    expect(store.completion().pendingNativeOperations).toBe(1);
    construction.resolve({
      deleteCredential: async () => false,
      getPassword: async () => undefined,
      setPassword,
    });
    await closing;
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('retains a late native write failure after caller cancellation for the close owner', async () => {
    const { backend, store } = fixture();
    const entered = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    backend.createEntry.mockResolvedValueOnce({
      deleteCredential: async () => false,
      getPassword: async () => undefined,
      setPassword: (...args) => {
        expect(args).toEqual(['fixture-value']);
        entered.resolve();
        return writing.promise;
      },
    });
    const controller = new AbortController();
    const caller = store.write('fixture-provider', 'fixture-value', controller.signal);
    await entered.promise;
    controller.abort();
    await expect(caller).rejects.toMatchObject({ name: 'AbortError' });
    const closing = store.close();
    const rejected = expect(closing).rejects.toMatchObject({
      errors: [{ code: 'credential_store_unavailable', operation: 'write' }],
      name: 'AggregateError',
    });
    writing.reject(new Error('fixture-native-write-denied'));
    await rejected;
    expect(store.completion().pendingNativeOperations).toBe(0);
    expect(store.completion().state).toBe('closed');
  });

  it('joins a cancelled native write before a clear can remove its late persisted result', async () => {
    const { backend, store, values } = fixture();
    const entered = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const deleteCredential = vi.fn(async () => values.delete('fixture-provider'));
    backend.createEntry.mockResolvedValue({
      deleteCredential,
      getPassword: async () => values.get('fixture-provider'),
      setPassword: async (value) => {
        entered.resolve();
        await writing.promise;
        values.set('fixture-provider', value);
      },
    });
    const controller = new AbortController();
    const caller = store.write('fixture-provider', 'fixture-value', controller.signal);
    await entered.promise;
    controller.abort();
    await expect(caller).rejects.toMatchObject({ name: 'AbortError' });
    const clearing = store.delete('fixture-provider');
    expect(deleteCredential).not.toHaveBeenCalled();
    writing.resolve();
    await expect(clearing).resolves.toBe(true);
    expect(values.has('fixture-provider')).toBe(false);
    await store.close();
  });

  it('closes admission and fences queued work before joining the backend owner', async () => {
    const { backend, store } = fixture();
    const entered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<string | undefined>();
    backend.createEntry.mockResolvedValueOnce({
      deleteCredential: async () => false,
      getPassword: () => {
        entered.resolve();
        return reading.promise;
      },
      setPassword: async () => undefined,
    });
    const first = store.read('first');
    await entered.promise;
    const second = store.write('second', 'fixture-value');
    const rejected = expect(second).rejects.toBeInstanceOf(CredentialStoreClosedError);
    const closing = store.close();
    reading.resolve(undefined);
    await first;
    await rejected;
    await closing;
    expect(backend.createEntry).toHaveBeenCalledOnce();
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it('reports backend close failure after joining it and never claims successful cleanup', async () => {
    const { backend, store } = fixture();
    backend.close.mockRejectedValueOnce(new Error('fixture-owner-close-denied'));
    await expect(store.close()).rejects.toMatchObject({
      errors: [{ code: 'credential_store_unavailable', operation: 'close' }],
      name: 'AggregateError',
    });
    expect(store.completion().pendingNativeOperations).toBe(0);
    expect(store.completion().state).toBe('closing');
    expect(backend.close).toHaveBeenCalledOnce();
  });
});
