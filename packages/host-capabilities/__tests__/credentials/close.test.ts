import type { KeyringCredentialBackend } from '@brainstrike/agent-host/credential-contract';
import { expect, it, vi } from 'vitest';
import { createHostCredentials, HostCredentialsClosedError } from '../../src/credentials.js';

it('keeps credentials lazy and joins admitted memory-backed reads before closing', async () => {
  const entered = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<string | undefined>();
  const backend = {
    close: vi.fn(async () => undefined),
    createEntry: async () => ({
      deleteCredential: async () => false,
      getPassword: () => {
        entered.resolve();
        return reading.promise;
      },
      setPassword: async () => undefined,
    }),
    listAccounts: async () => [],
  } satisfies KeyringCredentialBackend;
  const createNativeBackend = vi.fn(() => backend);
  const credentials = createHostCredentials({
    createNativeBackend,
    selection: { kind: 'keyring', service: 'fixture-profile-only' },
  });
  expect(createNativeBackend).not.toHaveBeenCalled();
  const store = credentials.store();
  const pending = store.read('fake-provider');
  await entered.promise;
  const closing = credentials.close();
  expect(credentials.close()).toBe(closing);
  expect(() => credentials.store()).toThrow(HostCredentialsClosedError);
  expect(() => credentials.secrets()).toThrow(HostCredentialsClosedError);
  expect(backend.close).not.toHaveBeenCalled();
  reading.resolve('fake-private-value');
  await expect(pending).resolves.toBe('fake-private-value');
  await closing;
  expect(createNativeBackend).toHaveBeenCalledTimes(1);
  expect(backend.close).toHaveBeenCalledTimes(1);
  expect(store.completion()).toMatchObject({ pendingNativeOperations: 0, state: 'closed' });
});
