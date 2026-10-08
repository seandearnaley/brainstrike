import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import type { HostCredentials } from '../src/credentials.js';
import { createHostProviderServices } from '../src/provider-services.js';

function credentialsWith(stored: Record<string, ProviderCredential>): {
  credentials: HostCredentials;
  secrets: Pick<SecretsService, 'getCredential' | 'getKey' | 'listProviders'>;
} {
  const secrets = {
    getCredential: vi.fn(async (provider: string) => stored[provider] ?? null),
    getKey: vi.fn(async (provider: string) => {
      const credential = stored[provider];
      return credential?.type === 'api_key' ? credential.key : null;
    }),
    listProviders: vi.fn(async () => Object.keys(stored)),
  };
  return {
    credentials: {
      close: async () => undefined,
      secrets: () => secrets as unknown as SecretsService,
      store: () => {
        throw new Error('The provider services never read raw accounts');
      },
    },
    secrets,
  };
}

describe('host provider services', () => {
  it('reports a key from the host credential store as a stored, configured provider', async () => {
    const { credentials } = credentialsWith({ openrouter: { key: 'stored-key', type: 'api_key' } });
    const services = createHostProviderServices({
      auth: { verify: vi.fn() },
      credentials,
      env: {},
      envFileFailures: [],
    });

    await expect(services.status()).resolves.toEqual({
      enabled: true,
      providerKeySources: [{ provider: 'openrouter', source: 'stored' }],
      providers: ['openrouter', 'local'],
    });
  });

  it('gates on a rejected env file without reading the store', async () => {
    const { credentials, secrets } = credentialsWith({
      openrouter: { key: 'stored-key', type: 'api_key' },
    });
    const failure = {
      code: 'env_file_invalid' as const,
      file: 'dev' as const,
      message: 'Desktop environment file ".env" is invalid at line 2: expected "=".',
    };
    const services = createHostProviderServices({
      auth: { verify: vi.fn() },
      credentials,
      env: {},
      envFileFailures: [failure],
    });

    await expect(services.status()).resolves.toEqual({
      enabled: false,
      envFileFailures: [failure],
      error: 'assistant_configuration_invalid',
      message: 'Desktop environment configuration is invalid.',
      providers: [],
    });
    expect(secrets.listProviders).not.toHaveBeenCalled();
  });

  it('verifies a subscription only for the desktop client, through the host refresher', async () => {
    const verify = vi.fn(async () => ({
      ok: false as const,
      status: 'reconnect_required' as const,
    }));
    const { credentials } = credentialsWith({});
    const services = createHostProviderServices({
      auth: { verify },
      credentials,
      env: {},
      envFileFailures: [],
    });

    await expect(services.verify('openai-codex', 'public-socket')).rejects.toThrow(
      'A subscription sign-in can be verified only from the desktop app.'
    );
    expect(verify).not.toHaveBeenCalled();
    await expect(services.verify('openai-codex', 'desktop-ui')).resolves.toMatchObject({
      result: { status: 'invalid' },
    });
    expect(verify).toHaveBeenCalledWith('openai-codex');
  });

  it('probes with the stored key and never echoes it', async () => {
    const requests: { authorization: string | null; url: string }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url: String(input),
      });
      return new Response('{}', { status: 401 });
    });
    const { credentials } = credentialsWith({ openrouter: { key: 'stored-key', type: 'api_key' } });
    const services = createHostProviderServices({
      auth: { verify: vi.fn() },
      credentials,
      env: {},
      envFileFailures: [],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const snapshot = await services.verify('openrouter', 'desktop-ui');

    expect(snapshot.result).toMatchObject({ detail: 'HTTP 401', status: 'invalid' });
    expect(requests).toEqual([
      { authorization: 'Bearer stored-key', url: 'https://openrouter.ai/api/v1/key' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('stored-key');
  });
});
