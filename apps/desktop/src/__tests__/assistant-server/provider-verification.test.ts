import { listProviders, type ProviderCredential } from '@brainstrike/assistant-contract';
import { describe, expect, it, type MockedFunction, vi } from 'vitest';
import {
  createProviderVerificationService,
  listApiKeyProbeProviderIds,
  MissingProviderCredentialError,
  UnknownVerificationProviderError,
} from '../../assistant-server/provider-verification';

const FAKE_KEY = 'sk-super-secret-test-key-000';

function apiKeyCredential(key = FAKE_KEY): ProviderCredential {
  return { key, type: 'api_key' };
}

function okResponse(body: unknown = { data: [] }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

interface ServiceOverrides {
  readonly env?: Record<string, string | undefined>;
  readonly failureTtlMs?: number;
  readonly fetchImpl?: MockedFunction<typeof fetch>;
  readonly findProvider?: (id: string) => { authType: 'api_key' | 'aws' | 'none' } | undefined;
  readonly now?: () => number;
  readonly readCredential?: (id: string) => Promise<ProviderCredential | undefined>;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
  readonly verifyAwsCredentialChain?: (
    profile: string | undefined,
    options?: { timeoutMs?: number }
  ) => Promise<
    { ok: true } | { detail: string; kind: 'no_credentials' | 'sso_expired' | 'unknown'; ok: false }
  >;
}

function createService(overrides: ServiceOverrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>().mockResolvedValue(okResponse());
  const service = createProviderVerificationService({
    ...(overrides.env ? { env: overrides.env } : {}),
    fetchImpl,
    now: overrides.now ?? (() => 1_000_000),
    readCredential:
      overrides.readCredential ?? ((_id: string) => Promise.resolve(apiKeyCredential())),
    ...(overrides.findProvider ? { findProvider: overrides.findProvider } : {}),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs }),
    ...(overrides.successTtlMs === undefined ? {} : { successTtlMs: overrides.successTtlMs }),
    ...(overrides.failureTtlMs === undefined ? {} : { failureTtlMs: overrides.failureTtlMs }),
    // BST-1353: without this the profile-chain probe would resolve the REAL
    // AWS chain — a network-touching, machine-dependent test.
    ...(overrides.verifyAwsCredentialChain
      ? { verifyAwsCredentialChain: overrides.verifyAwsCredentialChain }
      : {}),
  });
  return { fetchImpl, service };
}

describe('ProviderVerificationService probes', () => {
  it('verifies openai with a bearer GET against the models endpoint', async () => {
    const { fetchImpl, service } = createService();

    await expect(service.verify('openai')).resolves.toEqual({
      freshness: 'live',
      result: { checkedAt: new Date(1_000_000).toISOString(), status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${FAKE_KEY}` }),
        method: 'GET',
      })
    );
  });

  it('maps 401 to invalid — wrong key, not unreachable', async () => {
    const { service } = createService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 })),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { detail: 'HTTP 401', status: 'invalid' },
    });
  });

  it('maps an api_key 403 to verified_limited — authenticated but permission-scoped', async () => {
    const { service } = createService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: {
        detail: 'HTTP 403 — credential authenticated but lacks permission',
        status: 'verified_limited',
      },
    });
  });

  it('maps 429 to verified_limited — a valid key can be rate limited or out of quota', async () => {
    const { service } = createService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: {
        detail: 'HTTP 429 — credential authenticated but rate limited',
        status: 'verified_limited',
      },
    });
  });

  it('declares a probe for every registry api_key provider plus tavily', () => {
    const probeIds = listApiKeyProbeProviderIds();
    const apiKeyProviders = listProviders().filter(
      (definition) => definition.authType === 'api_key'
    );

    expect(apiKeyProviders.length).toBeGreaterThan(0);
    for (const definition of apiKeyProviders) {
      expect(probeIds).toContain(definition.id);
    }
    expect(probeIds).toContain('tavily');
  });

  it('sends anthropic the x-api-key and anthropic-version headers', async () => {
    const { fetchImpl, service } = createService();

    await expect(service.verify('anthropic')).resolves.toMatchObject({
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'anthropic-version': '2023-06-01',
          'x-api-key': FAKE_KEY,
        }),
      })
    );
  });

  it('probes google via header auth and classifies API_KEY_INVALID 400 as invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { details: [{ reason: 'API_KEY_INVALID' }], status: 'INVALID_ARGUMENT' },
        }),
        { status: 400 }
      )
    );
    const { service } = createService({ fetchImpl });

    await expect(service.verify('google')).resolves.toMatchObject({
      result: { status: 'invalid' },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(url).not.toContain(FAKE_KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE_KEY);
  });

  it('verifies openrouter via the key endpoint and reports bounded usage detail', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        okResponse({ data: { is_free_tier: false, label: 'sk-or-v1-abc', limit: 10, usage: 1.25 } })
      );
    const { service } = createService({ fetchImpl });

    const snapshot = await service.verify('openrouter');
    expect(snapshot.result.status).toBe('verified');
    expect(snapshot.result.detail).toBe('usage 1.25 of limit 10');
    // The key label is key material — it must never surface in the payload.
    expect(JSON.stringify(snapshot)).not.toContain('sk-or-v1-abc');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${FAKE_KEY}` }),
      })
    );
  });

  it('verifies cohere against its models listing', async () => {
    const { fetchImpl, service } = createService();

    await expect(service.verify('cohere')).resolves.toMatchObject({
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cohere.com/v1/models', expect.anything());
  });

  it('verifies voyage with a minimal embeddings POST (no model-list endpoint exists)', async () => {
    const { fetchImpl, service } = createService();

    await expect(service.verify('voyage')).resolves.toMatchObject({
      result: { status: 'verified' },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ input: ['ping'], model: 'voyage-3' });
  });

  it('verifies tavily against its usage endpoint', async () => {
    const { fetchImpl, service } = createService();

    await expect(service.verify('tavily')).resolves.toMatchObject({
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.tavily.com/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${FAKE_KEY}` }),
      })
    );
  });
});

describe('ProviderVerificationService aws probes', () => {
  const awsOverrides = (fetchImpl: MockedFunction<typeof fetch>): ServiceOverrides => ({
    fetchImpl,
    findProvider: (id) => (id === 'bedrock' ? { authType: 'aws' } : undefined),
    readCredential: () =>
      Promise.resolve({
        bearerKey: FAKE_KEY,
        mode: 'bearer',
        region: 'us-east-1',
        type: 'aws',
      }),
  });

  it('verifies a bedrock bearer credential against foundation-models', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const { service } = createService(awsOverrides(fetchImpl));

    await expect(service.verify('bedrock')).resolves.toMatchObject({
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bedrock.us-east-1.amazonaws.com/foundation-models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${FAKE_KEY}` }),
      })
    );
  });

  it('maps a bedrock 403 to verified_limited — authenticated but list-restricted', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
    const { service } = createService(awsOverrides(fetchImpl));

    const snapshot = await service.verify('bedrock');
    expect(snapshot.result.status).toBe('verified_limited');
    expect(snapshot.result.detail).toContain('403');
  });

  it('maps a bedrock 401 to invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    const { service } = createService(awsOverrides(fetchImpl));

    await expect(service.verify('bedrock')).resolves.toMatchObject({
      result: { status: 'invalid' },
    });
  });

  /**
   * BST-1353: a profile-chain credential is no longer `not_applicable` —
   * resolving the chain IS the probe. It never issues an HTTP request of its
   * own, so `fetchImpl` must stay untouched in every case below.
   */
  describe('aws profile-chain probe (BST-1353)', () => {
    function createChainService(
      verify: (
        profile: string | undefined,
        options?: { timeoutMs?: number }
      ) => Promise<
        | { ok: true }
        | { detail: string; kind: 'no_credentials' | 'sso_expired' | 'unknown'; ok: false }
      >,
      profile?: string
    ) {
      const fetchImpl = vi.fn<typeof fetch>();
      const verifyAwsCredentialChain = vi.fn(verify);
      const { service } = createService({
        fetchImpl,
        findProvider: () => ({ authType: 'aws' }),
        readCredential: () =>
          Promise.resolve({
            mode: 'profile_chain',
            region: 'us-east-1',
            type: 'aws',
            ...(profile ? { profile } : {}),
          }),
        verifyAwsCredentialChain,
      });
      return { fetchImpl, service, verifyAwsCredentialChain };
    }

    it('a resolvable chain reports verified_LIMITED — resolution never proves Bedrock access', async () => {
      // PR #2525 review, finding 5. `verified` means "the provider's API
      // accepted this credential" everywhere else in this module. Chain
      // resolution proves only that LOCAL credentials exist; it never touches
      // Bedrock, so claiming `verified` would quietly redefine the status for
      // one provider. verified_limited is the existing "authenticated but the
      // probe could not fully succeed" rung.
      const { fetchImpl, service, verifyAwsCredentialChain } = createChainService(
        () => Promise.resolve({ ok: true as const }),
        'acme-dev'
      );

      const snapshot = await service.verify('bedrock');
      expect(snapshot.result.status).toBe('verified_limited');
      expect(snapshot.result.detail).toContain('Bedrock access not exercised');
      expect(verifyAwsCredentialChain).toHaveBeenCalledWith('acme-dev', {
        timeoutMs: expect.any(Number),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('a NEVER-SETTLING chain settles as unreachable and frees the single-flight entry', async () => {
      // PR #2525 review, finding 3. `credential_process` can hang, an SSO
      // refresh can stall on a black-holed proxy, and IMDS has its own long
      // connect timeout. Without a deadline the pending entry never settles
      // and every later click awaits the same dead promise — a settings row
      // that spins forever.
      const fetchImpl = vi.fn<typeof fetch>();
      const { service } = createService({
        failureTtlMs: 1,
        fetchImpl,
        findProvider: () => ({ authType: 'aws' }),
        readCredential: () =>
          Promise.resolve({ mode: 'profile_chain', region: 'us-east-1', type: 'aws' }),
        requestTimeoutMs: 25,
        // Honors the deadline the service passes rather than hanging forever,
        // which is exactly what the real implementation does.
        verifyAwsCredentialChain: (_profile, options) =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  detail: 'the AWS credential chain timed out',
                  kind: 'unknown' as const,
                  ok: false as const,
                }),
              options?.timeoutMs ?? 0
            );
          }),
      });

      await expect(service.verify('bedrock')).resolves.toMatchObject({
        result: { status: 'unreachable' },
      });
      // The single-flight entry was released: a second click re-probes rather
      // than awaiting the first (dead) promise forever.
      await expect(service.verify('bedrock')).resolves.toMatchObject({
        result: { status: 'unreachable' },
      });
    });

    it('an EXPIRED SSO session is invalid, and the detail carries the login command', async () => {
      const { fetchImpl, service } = createChainService(
        () =>
          Promise.resolve({
            detail: 'AWS SSO session expired — run `aws sso login --profile acme-dev` …',
            kind: 'sso_expired' as const,
            ok: false as const,
          }),
        'acme-dev'
      );

      const snapshot = await service.verify('bedrock');
      expect(snapshot.result.status).toBe('invalid');
      expect(snapshot.result.detail).toContain('aws sso login --profile acme-dev');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('an empty chain is invalid and names the profile searched', async () => {
      const { service } = createChainService(
        () =>
          Promise.resolve({
            detail: 'No AWS credentials were found … for profile "acme-dev".',
            kind: 'no_credentials' as const,
            ok: false as const,
          }),
        'acme-dev'
      );

      const snapshot = await service.verify('bedrock');
      expect(snapshot.result.status).toBe('invalid');
      expect(snapshot.result.detail).toContain('acme-dev');
    });

    it('an UNRECOGNIZED chain failure is unreachable — no verdict obtainable, not wrong-key', async () => {
      const { service } = createChainService(() =>
        Promise.resolve({
          detail: 'AWS credential resolution failed …: socket hang up',
          kind: 'unknown' as const,
          ok: false as const,
        })
      );

      await expect(service.verify('bedrock')).resolves.toMatchObject({
        result: { status: 'unreachable' },
      });
    });

    it('passes an absent profile through as undefined (the chain default)', async () => {
      const { service, verifyAwsCredentialChain } = createChainService(() =>
        Promise.resolve({ ok: true as const })
      );

      await service.verify('bedrock');
      expect(verifyAwsCredentialChain).toHaveBeenCalledWith(undefined, {
        timeoutMs: expect.any(Number),
      });
    });
  });

  /**
   * PR #2529 review, finding 3. An environment variable cannot express the
   * aws credential union, so a Bedrock bearer supplied via
   * BRAINSTRIKE_BEDROCK_API_KEY / AWS_BEARER_TOKEN_BEDROCK arrives here as an
   * `api_key` credential — and so does every legacy bare-string key stored
   * under bedrock. The REQUEST path already projects that shape to aws bearer
   * auth using AWS_REGION, so the probe must agree; rejecting it reported
   * `verification_unsupported` for a credential real turns use successfully.
   */
  describe('aws bearer supplied as an api_key credential', () => {
    const envBearerOverrides = (
      fetchImpl: MockedFunction<typeof fetch>,
      env: Record<string, string | undefined>
    ): ServiceOverrides => ({
      env,
      fetchImpl,
      findProvider: (id) => (id === 'bedrock' ? { authType: 'aws' } : undefined),
      readCredential: () => Promise.resolve(apiKeyCredential('env-bedrock-bearer')),
    });

    it('probes the bearer path using AWS_REGION, matching the request projection', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
      const { service } = createService(envBearerOverrides(fetchImpl, { AWS_REGION: 'eu-west-1' }));

      await expect(service.verify('bedrock')).resolves.toMatchObject({
        result: { status: 'verified' },
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://bedrock.eu-west-1.amazonaws.com/foundation-models',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer env-bedrock-bearer' }),
        })
      );
    });

    it('says the REGION is missing when AWS_REGION is unset, not that the credential is unsupported', async () => {
      // NO SILENT FALLBACK and no misdiagnosis: there is no default region
      // (BST-1350), so the actionable answer is "configure a region" — the
      // same thing the factory tells the request path.
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
      const { service } = createService(envBearerOverrides(fetchImpl, {}));

      await expect(service.verify('bedrock')).rejects.toThrow(/AWS region/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('still rejects a credential type that is neither aws nor api_key', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
      const { service } = createService({
        env: { AWS_REGION: 'us-east-1' },
        fetchImpl,
        findProvider: () => ({ authType: 'aws' }),
        readCredential: () =>
          Promise.resolve({ access: 'a', expires: 1, refresh: 'r', type: 'oauth' }),
      });

      await expect(service.verify('bedrock')).rejects.toThrow(/AWS credential/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe('ProviderVerificationService failure classification', () => {
  it('maps a network error to unreachable — wifi-down, not wrong-key', async () => {
    const { service } = createService({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { detail: 'fetch failed', status: 'unreachable' },
    });
  });

  it('maps a timeout to unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        })
    );
    const { service } = createService({ fetchImpl, requestTimeoutMs: 5 });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { detail: 'Request timed out after 5ms', status: 'unreachable' },
    });
  });

  it('maps a non-auth HTTP failure to unreachable, never invalid', async () => {
    const { service } = createService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { detail: 'HTTP 503', status: 'unreachable' },
    });
  });
});

describe('ProviderVerificationService routing and caching', () => {
  it('routes authType none to not_applicable with zero credential reads and zero fetches', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const readCredential = vi.fn<(id: string) => Promise<ProviderCredential | undefined>>();
    const { service } = createService({ fetchImpl, readCredential });

    await expect(service.verify('ollama')).resolves.toMatchObject({
      result: { status: 'not_applicable' },
    });
    await expect(service.verify('lmstudio')).resolves.toMatchObject({
      result: { status: 'not_applicable' },
    });
    await expect(service.verify('local')).resolves.toMatchObject({
      result: { status: 'not_applicable' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider id before any credential read or fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const readCredential = vi.fn<(id: string) => Promise<ProviderCredential | undefined>>();
    const { service } = createService({ fetchImpl, readCredential });

    await expect(service.verify('not-a-provider')).rejects.toBeInstanceOf(
      UnknownVerificationProviderError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
  });

  it('rejects a provider without a configured credential', async () => {
    const { service } = createService({
      readCredential: () => Promise.resolve(undefined),
    });

    await expect(service.verify('openai')).rejects.toBeInstanceOf(MissingProviderCredentialError);
  });

  it('single-flights concurrent probes for the same provider', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const { service } = createService({ fetchImpl });

    const first = service.verify('openai');
    const second = service.verify('openai');
    // Allow both credential reads to settle into the shared in-flight probe.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    resolveResponse?.(okResponse());

    const [a, b] = await Promise.all([first, second]);
    expect(a.result.status).toBe('verified');
    expect(b.result.status).toBe('verified');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh-cache result inside the TTL and re-probes after it', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const { service } = createService({ fetchImpl, now: () => now, successTtlMs: 60_000 });

    await expect(service.verify('openai')).resolves.toMatchObject({ freshness: 'live' });
    now += 30_000;
    await expect(service.verify('openai')).resolves.toMatchObject({ freshness: 'fresh-cache' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 31_000;
    await expect(service.verify('openai')).resolves.toMatchObject({ freshness: 'live' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches failures only briefly: unreachable re-probes after the short failure TTL', async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse());
    const { service } = createService({ fetchImpl, now: () => now });

    await expect(service.verify('openai')).resolves.toMatchObject({
      freshness: 'live',
      result: { status: 'unreachable' },
    });
    // Inside the 3s failure TTL: click-storm dedup only.
    now += 1000;
    await expect(service.verify('openai')).resolves.toMatchObject({
      freshness: 'fresh-cache',
      result: { status: 'unreachable' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Past it: the wifi coming back must be observable on the next click,
    // never pinned behind the 60s success TTL.
    now += 2100;
    await expect(service.verify('openai')).resolves.toMatchObject({
      freshness: 'live',
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('samples the cache timestamp AFTER the probe resolves so a slow failure keeps its full TTL', async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        // The probe itself consumed 10s (e.g. the timeout path) before failing.
        now += 10_000;
        return Promise.reject(new TypeError('fetch failed'));
      })
      .mockResolvedValueOnce(okResponse());
    const { service } = createService({ fetchImpl, now: () => now });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { status: 'unreachable' },
    });
    // 2s after the failure RESOLVED — still inside the 3s failure TTL. If the
    // timestamp were sampled at probe START, the 10s probe would have burned
    // the whole window and this would re-probe.
    now += 2000;
    await expect(service.verify('openai')).resolves.toMatchObject({ freshness: 'fresh-cache' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 1100;
    await expect(service.verify('openai')).resolves.toMatchObject({ freshness: 'live' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-probes immediately when the stored credential changes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(okResponse());
    let key = 'sk-old-and-wrong';
    const { service } = createService({
      fetchImpl,
      readCredential: () => Promise.resolve(apiKeyCredential(key)),
    });

    await expect(service.verify('openai')).resolves.toMatchObject({
      result: { status: 'invalid' },
    });
    key = 'sk-new-and-right';
    await expect(service.verify('openai')).resolves.toMatchObject({
      freshness: 'live',
      result: { status: 'verified' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never leaks credential material into any snapshot payload', async () => {
    const responses = [
      okResponse({ data: { label: FAKE_KEY, limit: null, usage: 0 } }),
      new Response(JSON.stringify({ error: FAKE_KEY }), { status: 401 }),
      new Response(FAKE_KEY, { status: 503 }),
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(responses.shift() ?? okResponse()));
    const { service } = createService({ fetchImpl, successTtlMs: 1 });

    for (const provider of ['openrouter', 'openai', 'anthropic']) {
      const snapshot = await service.verify(provider);
      expect(JSON.stringify(snapshot)).not.toContain(FAKE_KEY);
    }
  });
});
