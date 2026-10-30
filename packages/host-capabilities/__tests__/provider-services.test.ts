import { toBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
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
      auth: { secrets: credentials.secrets },
      env: {},
      envFileFailures: [],
    });

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
      auth: { secrets: credentials.secrets },
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
      auth: { secrets: credentials.secrets },
      env: {},
      envFileFailures: [],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const snapshot = await services.verify('openrouter', open);

    expect(snapshot.result).toMatchObject({ detail: 'HTTP 401', status: 'invalid' });
    expect(requests).toEqual([
      { authorization: 'Bearer stored-key', url: 'https://openrouter.ai/api/v1/key' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('stored-key');
  });
});

describe('host provider services: a profile without an OpenRouter key (BST-2346)', () => {
  it('answers a metadata read with the reason and its remedy, and the boundary logs no error', async () => {
    const fetchImpl = vi.fn();
    const { credentials } = credentialsWith({});
    const services = createHostProviderServices({
      auth: { secrets: credentials.secrets },
      env: {},
      envFileFailures: [],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const cause = await services.openRouterModel('anthropic/claude-sonnet-4.6', open).then(
      () => undefined,
      (error: unknown) => error
    );
    const log = vi.fn();
    const response = toBoundaryResponseError(cause, log);

    expect(response.data).toEqual({
      category: 'configuration',
      code: 'provider.credential-missing',
      kind: 'refusal',
      message: 'No API key configured for provider "openrouter".',
      remedy: 'Add an OpenRouter API key in Providers.',
    });
    // Each logged boundary failure is one more error on the status bar.
    expect(log).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('host provider services: one configured OpenRouter origin', () => {
  it('sends the model metadata lookup where the key probe goes, from the host env', async () => {
    // The ambient process env names another origin; the host's own env decides.
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:9/ambient');
    try {
      const urls: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response('{}', { status: 401 });
      });
      const { credentials } = credentialsWith({
        openrouter: { key: 'stored-key', type: 'api_key' },
      });
      const services = createHostProviderServices({
        auth: { secrets: credentials.secrets },
        env: { OPENROUTER_BASE_URL: 'http://127.0.0.1:9/boundary' },
        envFileFailures: [],
        fetchImpl: fetchImpl as typeof fetch,
      });

      await services.verify('openrouter', open);
      await expect(services.openRouterModel('anthropic/claude-sonnet-4.6', open)).rejects.toThrow(
        'OpenRouter Models API returned status 401'
      );

      expect(urls).toEqual([
        'http://127.0.0.1:9/boundary/key',
        'http://127.0.0.1:9/boundary/model/anthropic/claude-sonnet-4.6',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
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
    const cancelled = provider.verify('openai', leaving.signal);
    const staying = provider.verify('openai', open);
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
    const cancelled = provider.verify('openai', leaving.signal);
    await vi.waitFor(() => expect(held.signals).toHaveLength(1));
    leaving.abort(new Error('The only caller left'));

    await expect(cancelled).rejects.toThrow('The only caller left');
    expect(held.signals[0]?.aborted).toBe(true);
    const next = provider.verify('openai', open);
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

  it('releases a caller whose credential read is still held, for both provider reads', async () => {
    const read = Promise.withResolvers<null>();
    const secrets = {
      getCredential: vi.fn(async () => await read.promise),
      getKey: vi.fn(async () => null),
      listProviders: vi.fn(async () => []),
    };
    const held = heldFetch();
    const provider = createHostProviderServices({
      auth: { secrets: () => secrets as unknown as SecretsService },
      env: {},
      envFileFailures: [],
      fetchImpl: held.fetchImpl,
    });
    const leaving = new AbortController();
    const verifying = provider.verify('openai', leaving.signal);
    const reading = provider.openRouterModel('openai/gpt-5.4-mini', leaving.signal);
    await vi.waitFor(() => expect(secrets.getCredential).toHaveBeenCalledTimes(2));
    const reason = new Error('The caller left during the credential read');
    leaving.abort(reason);

    await expect(verifying).rejects.toBe(reason);
    await expect(reading).rejects.toBe(reason);
    read.resolve(null);
    expect(held.fetchImpl).not.toHaveBeenCalled();
  });
});
