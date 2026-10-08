import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeyringCredentialStore } from '@brainstrike/agent-host/keyring-credentials';
import { providerEnvKeys } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createHostCredentials,
  createHostProviderAuth,
  HostCredentialStoreUnselectedError,
  HostCredentialsClosedError,
  LegacySecretConflictError,
  LegacySecretVerificationError,
  migrateLegacySecrets,
} from '../src/index.js';
import { memoryCredentialBackend } from './fixtures/memory-credential-backend.js';

const OAUTH_ACCOUNT = 'a'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function openAiEnvKey(): string {
  const [key] = providerEnvKeys('openai');
  if (!key) {
    throw new Error('openai declares no env key');
  }
  return key;
}

test('no explicit selection means no credential authority, never a file fallback', async () => {
  const credentials = createHostCredentials({ selection: undefined });
  expect(() => credentials.secrets()).toThrow(HostCredentialStoreUnselectedError);
  const resolve = createHostProviderAuth({ credentials, env: {} });
  await expect(resolve('openai')).rejects.toThrow(HostCredentialStoreUnselectedError);
  await credentials.close();
});

test('env bearer keys outrank the store without opening it', async () => {
  const credentials = createHostCredentials({ selection: undefined });
  const resolve = createHostProviderAuth({
    credentials,
    env: { [openAiEnvKey()]: 'env-fixture-key' },
  });
  await expect(resolve('openai')).resolves.toEqual({ apiKey: 'env-fixture-key', kind: 'api_key' });
  await expect(resolve('not-a-provider')).rejects.toThrow('Unsupported provider');
});

test('a selected keyring store resolves the stored typed credential and excludes OAuth records', async () => {
  const memory = memoryCredentialBackend({
    [OAUTH_ACCOUNT]: '{"oauth":"record"}',
    openai: JSON.stringify({ key: 'stored-fixture-key', type: 'api_key' }),
  });
  const credentials = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const resolve = createHostProviderAuth({ credentials, env: {} });
  await expect(resolve('openai')).resolves.toEqual({
    apiKey: 'stored-fixture-key',
    kind: 'api_key',
  });
  await expect(resolve('anthropic')).rejects.toThrow('no configured credential');
  expect(await credentials.secrets().listProviders()).toEqual(['openai']);
  expect(new Set(memory.services)).toEqual(new Set(['brainstrike-test-disposable']));
  await credentials.close();
  expect(() => credentials.store()).toThrow(HostCredentialsClosedError);
});

test('a selected private file store keeps the existing account and file shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-capabilities-'));
  directories.push(directory);
  const path = join(directory, 'credentials.json');
  const credentials = createHostCredentials({ selection: { kind: 'file', path } });
  await credentials.secrets().saveKey('openai', 'file-fixture-key');
  await credentials.store().write(OAUTH_ACCOUNT, '{"oauth":"record"}');
  await credentials.close();
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(persisted.secrets)).toEqual(['openai']);
  expect(Object.keys(persisted.records)).toEqual([OAUTH_ACCOUNT]);
  const reopened = createHostCredentials({ selection: { kind: 'file', path } });
  const resolve = createHostProviderAuth({ credentials: reopened, env: {} });
  await expect(resolve('openai')).resolves.toEqual({ apiKey: 'file-fixture-key', kind: 'api_key' });
  await reopened.close();
});

function legacySource(entries: Record<string, string>) {
  const calls: string[] = [];
  let retired = false;
  return {
    calls,
    get retired() {
      return retired;
    },
    source: {
      entries: async () => {
        calls.push('entries');
        return retired
          ? []
          : Object.entries(entries).map(([account, value]) => ({ account, value }));
      },
      retire: async () => {
        calls.push('retire');
        retired = true;
      },
    },
  };
}

test('migration copies every account under its name, verifies, then retires the legacy store', async () => {
  const memory = memoryCredentialBackend();
  const destination = createKeyringCredentialStore({ backend: memory.backend, service: 'test' });
  const legacy = legacySource({ [OAUTH_ACCOUNT]: 'oauth-record', openai: 'provider-envelope' });
  await expect(migrateLegacySecrets({ destination, source: legacy.source })).resolves.toEqual({
    alreadyPresent: 0,
    migrated: 2,
  });
  expect(Object.fromEntries(memory.entries)).toEqual({
    [OAUTH_ACCOUNT]: 'oauth-record',
    openai: 'provider-envelope',
  });
  expect(legacy.calls).toEqual(['entries', 'retire']);
  // One-time: a later pass finds nothing left to move and retires nothing.
  await expect(migrateLegacySecrets({ destination, source: legacy.source })).resolves.toEqual({
    alreadyPresent: 0,
    migrated: 0,
  });
  expect(legacy.calls).toEqual(['entries', 'retire', 'entries']);
  await destination.close();
});

test('an interrupted earlier pass is re-runnable: identical values count as present', async () => {
  const memory = memoryCredentialBackend({ openai: 'provider-envelope' });
  const destination = createKeyringCredentialStore({ backend: memory.backend, service: 'test' });
  const legacy = legacySource({ anthropic: 'second', openai: 'provider-envelope' });
  await expect(migrateLegacySecrets({ destination, source: legacy.source })).resolves.toEqual({
    alreadyPresent: 1,
    migrated: 1,
  });
  expect(legacy.retired).toBe(true);
  await destination.close();
});

test('a conflicting destination value refuses before any write and keeps the legacy store', async () => {
  const memory = memoryCredentialBackend({ openai: 'newer-keyring-value' });
  const destination = createKeyringCredentialStore({ backend: memory.backend, service: 'test' });
  const legacy = legacySource({ anthropic: 'unwritten', openai: 'legacy-value' });
  const failure = migrateLegacySecrets({ destination, source: legacy.source });
  await expect(failure).rejects.toBeInstanceOf(LegacySecretConflictError);
  await expect(failure).rejects.toMatchObject({ accounts: ['openai'] });
  expect(Object.fromEntries(memory.entries)).toEqual({ openai: 'newer-keyring-value' });
  expect(legacy.retired).toBe(false);
  await destination.close();
});

test('a value that does not read back keeps the legacy store', async () => {
  const memory = memoryCredentialBackend();
  const lossy = {
    ...memory.backend,
    createEntry: async (request: Parameters<typeof memory.backend.createEntry>[0]) => {
      const entry = await memory.backend.createEntry(request);
      return { ...entry, setPassword: async () => undefined };
    },
  };
  const destination = createKeyringCredentialStore({ backend: lossy, service: 'test' });
  const legacy = legacySource({ openai: 'legacy-value' });
  await expect(migrateLegacySecrets({ destination, source: legacy.source })).rejects.toBeInstanceOf(
    LegacySecretVerificationError
  );
  expect(legacy.retired).toBe(false);
  await destination.close();
});

test('a legacy decrypt failure propagates and nothing is written or retired', async () => {
  const memory = memoryCredentialBackend();
  const destination = createKeyringCredentialStore({ backend: memory.backend, service: 'test' });
  let retired = false;
  await expect(
    migrateLegacySecrets({
      destination,
      source: {
        entries: () => Promise.reject(new Error('decrypt_failed')),
        retire: async () => {
          retired = true;
        },
      },
    })
  ).rejects.toThrow('decrypt_failed');
  expect(memory.entries.size).toBe(0);
  expect(retired).toBe(false);
  await destination.close();
});
