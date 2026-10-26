import { expect, test } from 'vitest';
import { createHostAuthority, createHostCredentials } from '../src/index.js';
import { memoryCredentialBackend } from './fixtures/memory-credential-backend.js';

function hostAuthority() {
  const memory = memoryCredentialBackend({
    anthropic: JSON.stringify({ key: 'sk-seeded-fixture', type: 'api_key' }),
  });
  const credentials = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const auth = createHostAuthority({ credentials, env: {} });
  return { auth, credentials, memory };
}

test('factory reset drops every stored credential', async () => {
  const { auth, credentials, memory } = hostAuthority();
  try {
    await expect(auth.clear()).resolves.toBe(true);
    expect(memory.entries.size).toBe(0);
  } finally {
    await credentials.close();
  }
});

test('Settings writes go through the host authority', async () => {
  const { auth, credentials, memory } = hostAuthority();
  try {
    await auth.setCredential('openai', { key: 'sk-settings-fixture', type: 'api_key' });
    expect(JSON.parse(memory.entries.get('openai') ?? 'null')).toEqual({
      key: 'sk-settings-fixture',
      type: 'api_key',
    });
    await expect(auth.deleteCredential('openai')).resolves.toBe(true);
    expect(memory.entries.has('openai')).toBe(false);
  } finally {
    await credentials.close();
  }
});
