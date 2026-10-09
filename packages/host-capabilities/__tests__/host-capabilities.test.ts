import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerEnvKeys } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createHostCredentials,
  createHostProviderAuth,
  HostCredentialStoreUnselectedError,
  HostCredentialsClosedError,
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
