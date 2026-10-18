import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import type { HostCredentials } from '../src/credentials.js';
import { createHostProviderServices } from '../src/provider-services.js';

const { signal: open } = new AbortController();

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
      auth: { secrets: credentials.secrets, verify: vi.fn() },
      env: {},
      envFileFailures: [],
    });

    // Keyed providers only: the built-in on-device provider is embeddings-only
    // and must not be advertised as an available chat provider — the renderer's
    // status validator refuses a provider with no registry default model.
    await expect(services.status()).resolves.toEqual({
      enabled: true,
      providerKeySources: [{ provider: 'openrouter', source: 'stored' }],
      providers: ['openrouter'],
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
      auth: { secrets: credentials.secrets, verify: vi.fn() },
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
      auth: { secrets: credentials.secrets, verify },
      env: {},
      envFileFailures: [],
    });

    await expect(services.verify('openai-codex', 'public-socket', open)).rejects.toThrow(
      'A subscription sign-in can be verified only from the desktop app.'
    );
    expect(verify).not.toHaveBeenCalled();
    await expect(services.verify('openai-codex', 'desktop-ui', open)).resolves.toMatchObject({
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
      auth: { secrets: credentials.secrets, verify: vi.fn() },
      env: {},
      envFileFailures: [],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const snapshot = await services.verify('openrouter', 'desktop-ui', open);

    expect(snapshot.result).toMatchObject({ detail: 'HTTP 401', status: 'invalid' });
    expect(requests).toEqual([
      { authorization: 'Bearer stored-key', url: 'https://openrouter.ai/api/v1/key' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('stored-key');
  });
});

/** A provider fetch that answers only when the test says, and honours its signal like fetch. */
function heldFetch() {
  const signals: AbortSignal[] = [];
  const answers: Array<() => void> = [];
  const fetchImpl = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        answers.push(() => resolve(new Response('{}', { status: 200 })));
      })
  );
  return { answer: () => answers.at(-1)?.(), fetchImpl: fetchImpl as typeof fetch, signals };
}

describe('host provider services: a caller cancels only its own wait (BST-2174)', () => {
  const services = (fetchImpl: typeof fetch) =>
    createHostProviderServices({
      auth: {
        secrets: credentialsWith({ openai: { key: 'stored-key', type: 'api_key' } }).credentials
          .secrets,
        verify: vi.fn(),
      },
      env: {},
      envFileFailures: [],
      fetchImpl,
    });

  it("answers a cancelled caller with its reason and leaves the shared probe to the other's verdict", async () => {
    const held = heldFetch();
    const provider = services(held.fetchImpl);
    const leaving = new AbortController();
    // Both join the one single-flight probe before either leaves.
    const cancelled = provider.verify('openai', 'public-socket', leaving.signal);
    const staying = provider.verify('openai', 'public-socket', open);
    await vi.waitFor(() => expect(held.signals).toHaveLength(1));
    const reason = new Error('This caller left');
    leaving.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    expect(held.signals[0]?.aborted).toBe(false);
    held.answer();
    await expect(staying).resolves.toMatchObject({ freshness: 'live' });
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts the probe once no caller waits, and caches no verdict for it', async () => {
    const held = heldFetch();
    const provider = services(held.fetchImpl);
    const leaving = new AbortController();
    const cancelled = provider.verify('openai', 'public-socket', leaving.signal);
    await vi.waitFor(() => expect(held.signals).toHaveLength(1));
    leaving.abort(new Error('The only caller left'));

    await expect(cancelled).rejects.toThrow('The only caller left');
    expect(held.signals[0]?.aborted).toBe(true);
    const next = provider.verify('openai', 'public-socket', open);
    await vi.waitFor(() => expect(held.signals).toHaveLength(2));
    held.answer();
    await expect(next).resolves.toMatchObject({ freshness: 'live' });
  });

  it("aborts an OpenRouter metadata read's fetch with its caller's reason", async () => {
    const held = heldFetch();
    const provider = createHostProviderServices({
      auth: {
        secrets: credentialsWith({ openrouter: { key: 'stored-key', type: 'api_key' } }).credentials
          .secrets,
        verify: vi.fn(),
      },
      env: {},
      envFileFailures: [],
      fetchImpl: held.fetchImpl,
    });
    const leaving = new AbortController();
    const cancelled = provider.openRouterModel('openai/gpt-5.4-mini', leaving.signal);
    await vi.waitFor(() => expect(held.signals).toHaveLength(1));
    const reason = new Error('The reader left');
    leaving.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    expect(held.signals[0]?.aborted).toBe(true);
  });
});
