import { afterEach, describe, expect, it } from 'vitest';
import { createHostCredentials, type HostCredentials } from '../src/index.js';
import {
  createSecretsMcpBearerCredentialAuthority,
  createSecretsMcpBearerCredentialWriter,
  mcpBearerCredentialStorageKey,
} from '../src/mcp/bearer-credential.js';
import { memoryCredentialBackend } from './fixtures/memory-credential-backend.js';

const ID = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'github_pat_fixture0123456789';
const opened: HostCredentials[] = [];

function credentials() {
  const memory = memoryCredentialBackend();
  const host = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  opened.push(host);
  return { host, memory };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((host) => host.close()));
});

describe('MCP bearer credential writer', () => {
  it('stores a token under a fresh reference that the bearer reader resolves', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);

    const reference = await writer.create(TOKEN);

    expect(reference).toEqual({ id: ID, store: 'mcp-credentials' });
    expect([...memory.entries.keys()]).toEqual([mcpBearerCredentialStorageKey(reference)]);
    await expect(
      createSecretsMcpBearerCredentialAuthority(host.secrets()).inspect(reference)
    ).resolves.toEqual({ state: 'stored' });
    expect(JSON.stringify(reference)).not.toContain(TOKEN);
  });

  it('refuses a malformed token before anything is stored', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);

    await expect(writer.create('has a space')).rejects.toMatchObject({
      code: 'mcp-bearer-credential-malformed',
    });
    expect(memory.entries.size).toBe(0);
  });

  it('removes a stored token and reports a removal that found nothing', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);
    const reference = await writer.create(TOKEN);

    await writer.delete(reference);

    expect(memory.entries.size).toBe(0);
    await expect(writer.delete(reference)).rejects.toThrow(
      'MCP bearer credential could not be removed'
    );
  });
});
