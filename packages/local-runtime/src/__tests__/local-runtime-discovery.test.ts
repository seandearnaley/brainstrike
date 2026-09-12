import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRuntimeDiscoveryService } from '../local-runtime-discovery';

type FetchMockInput = string | URL | Request;
type FetchMock = (input: FetchMockInput, init?: RequestInit) => Promise<Response>;

function getRequestUrl(input: FetchMockInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
    },
    status,
  });
}

describe('local-runtime-discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports host-disabled browser access without issuing a forbidden request', async () => {
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'model' }] }));
    const service = new LocalRuntimeDiscoveryService({
      browserUnavailableReason: 'This host does not permit direct runtime connections.',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1000,
    });
    await expect(service.probeRuntime('ollama', { force: true, surface: 'web' })).resolves.toEqual({
      checkedAt: 1000,
      message: 'This host does not permit direct runtime connections.',
      state: 'blocked_web',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.probeRuntime('ollama', { surface: 'desktop' })).resolves.toMatchObject({
      state: 'blocked_web',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const nativeService = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      nativeService.probeRuntime('ollama', { surface: 'desktop' })
    ).resolves.toMatchObject({ state: 'available' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks Ollama as available when /v1/models responds with OpenAI-compatible payload', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'nomic-embed-text' }],
      })
    );

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1000,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    expect(status).toMatchObject({
      endpoint: 'http://127.0.0.1:11434/v1/models',
      state: 'available',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Ollama /api/version when /v1/models is unavailable', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/v1/models')) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/api/version')) {
        return jsonResponse({ version: '0.5.7' });
      }
      return jsonResponse({ models: [] });
    });

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 2000,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    expect(status).toMatchObject({
      endpoint: 'http://127.0.0.1:11434/api/version',
      state: 'available',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns auth_required for 401/403 probe responses', async () => {
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 3000,
    });

    const status = await service.probeRuntime('lmstudio', { surface: 'desktop' });

    expect(status).toMatchObject({
      endpoint: 'http://127.0.0.1:1234/v1/models',
      state: 'auth_required',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns incompatible when probe endpoints respond with unknown payload shapes', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(jsonResponse({ hello: 'world' }));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 4000,
    });

    const status = await service.probeRuntime('ollama', { surface: 'desktop' });

    expect(status).toMatchObject({
      endpoint: 'http://127.0.0.1:11434/v1/models',
      state: 'incompatible',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats empty OpenAI model lists as incompatible for LM Studio probes', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({
        data: [],
      })
    );

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 4500,
    });

    const status = await service.probeRuntime('lmstudio', { surface: 'desktop' });

    expect(status.state).toBe('incompatible');
    if (status.state !== 'incompatible') {
      throw new Error('Expected incompatible runtime status');
    }
    expect(status.message).toContain('Unexpected response shape');
  });

  it('returns blocked_web for browser-localhost probes blocked under HTTPS', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'https:' },
    });

    const fetchMock = vi.fn<FetchMock>().mockRejectedValue(new TypeError('Failed to fetch'));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 5000,
    });

    const status = await service.probeRuntime('lmstudio', { surface: 'web' });

    expect(status.state).toBe('blocked_web');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns stale when a previously available runtime becomes unreachable', async () => {
    let nowMs = 10_000;
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }],
        })
      )
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => nowMs,
      successTtlMs: 1000,
    });

    const first = await service.probeRuntime('ollama', { surface: 'desktop' });
    expect(first.state).toBe('available');
    if (first.state !== 'available') {
      throw new Error('Expected available runtime status');
    }

    nowMs = 20_000;
    const second = await service.probeRuntime('ollama', { force: true, surface: 'desktop' });

    expect(second.state).toBe('stale');
    if (second.state !== 'stale') {
      throw new Error('Expected stale runtime status');
    }
    expect(second.reason).toBe('unavailable');
    expect(second.endpoint).toBe(first.endpoint);
    expect(second.lastSuccessfulAt).toBe(first.checkedAt);
  });

  it('applies failure backoff to avoid repeated probe spam', async () => {
    let nowMs = 30_000;
    const fetchMock = vi
      .fn<FetchMock>()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1234'));

    const service = new LocalRuntimeDiscoveryService({
      failureBaseBackoffMs: 2000,
      failureMaxBackoffMs: 10_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => nowMs,
    });

    const first = await service.probeRuntime('lmstudio', { surface: 'desktop' });
    expect(first.state).toBe('unavailable');
    // Three probe endpoints: /v1/models, /api/v1/models (0.4.0+), /api/v0/models (legacy).
    expect(fetchMock).toHaveBeenCalledTimes(3);

    nowMs = 31_000;
    const second = await service.probeRuntime('lmstudio', { surface: 'desktop' });
    expect(second.state).toBe('unavailable');
    // Within backoff window: no new probes issued, count unchanged at 3.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    nowMs = 34_000;
    await service.probeRuntime('lmstudio', { surface: 'desktop' });
    // Backoff elapsed: three additional probe calls fire (one per endpoint).
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('probes all runtimes and returns a typed status record', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('11434')) {
        return jsonResponse({
          data: [{ id: 'nomic-embed-text' }],
        });
      }
      return jsonResponse({
        data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }],
      });
    });

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 40_000,
    });

    const statuses = await service.probeAll({ surface: 'desktop' });

    expect(statuses.ollama.state).toBe('available');
    expect(statuses.lmstudio.state).toBe('available');
  });

  it('honors per-call baseUrl and bearer token overrides', async () => {
    const observedUrls: string[] = [];
    const observedAuth: (string | null)[] = [];
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = getRequestUrl(input);
      observedUrls.push(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      observedAuth.push(headers.get('authorization'));
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'qwen3:latest' }] });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 50_000,
    });

    const status = await service.probeRuntime('ollama', {
      endpoint: { apiToken: 'tok_abc', baseUrl: 'https://gpu.lan:11434' },
      surface: 'desktop',
    });

    expect(status.state).toBe('available');
    expect(observedUrls[0]).toBe('https://gpu.lan:11434/v1/models');
    expect(observedAuth[0]).toBe('Bearer tok_abc');
  });

  it('invalidates cache when the baseUrl changes between probes', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      urls.push(url);
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'qwen3:latest' }] });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeDiscoveryService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 60_000,
      successTtlMs: 60_000,
    });

    await service.probeRuntime('ollama', { surface: 'desktop' });
    // Second call with a different baseUrl must bypass the fresh cache entry.
    const second = await service.probeRuntime('ollama', {
      endpoint: { baseUrl: 'http://remote.box:11434' },
      surface: 'desktop',
    });

    expect(second.state).toBe('available');
    expect(urls.some((url) => url.startsWith('http://remote.box:11434'))).toBe(true);
  });
});
