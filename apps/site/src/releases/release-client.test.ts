import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseManifestClient } from './release-client';

const UNPUBLISHED_MANIFEST = {
  channel: 'stable',
  distribution: null,
  latest: null,
  product: 'Brainstrike',
  schemaVersion: 2,
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createReleaseManifestClient', () => {
  it('requests a configurable same-origin path with conditional revalidation', async () => {
    const fetchManifest = vi.fn(async () => jsonResponse(UNPUBLISHED_MANIFEST));
    const client = createReleaseManifestClient({
      fetch: fetchManifest,
      path: '/product/releases/stable.json',
    });

    await expect(client.load()).resolves.toMatchObject({ latest: null, schemaVersion: 2 });
    expect(fetchManifest).toHaveBeenCalledWith('/product/releases/stable.json', {
      cache: 'no-cache',
      headers: { accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('deduplicates one in-flight request and caches only the successful value', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchManifest = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const client = createReleaseManifestClient({ fetch: fetchManifest });

    const first = client.load();
    const second = client.load();
    expect(first).toBe(second);
    expect(fetchManifest).toHaveBeenCalledTimes(1);

    resolveResponse?.(jsonResponse(UNPUBLISHED_MANIFEST));
    await expect(first).resolves.toMatchObject({ latest: null });
    await expect(client.load()).resolves.toMatchObject({ latest: null });
    expect(fetchManifest).toHaveBeenCalledTimes(1);
  });

  it('revalidates a successful manifest after the bounded cache lifetime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    const fetchManifest = vi.fn(async () => jsonResponse(UNPUBLISHED_MANIFEST));
    const client = createReleaseManifestClient({ cacheTtlMs: 1000, fetch: fetchManifest });

    await client.load();
    await vi.advanceTimersByTimeAsync(999);
    await client.load();
    expect(fetchManifest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await client.load();
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('invalidates a successful value and explicitly retries', async () => {
    const fetchManifest = vi.fn(async () => jsonResponse(UNPUBLISHED_MANIFEST));
    const client = createReleaseManifestClient({ fetch: fetchManifest });

    await client.load();
    client.invalidate();
    await client.retry();

    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('invalidates an active request before retrying it', async () => {
    const fetchManifest = vi
      .fn()
      .mockImplementationOnce(async () => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse(UNPUBLISHED_MANIFEST));
    const client = createReleaseManifestClient({ fetch: fetchManifest });

    const staleRequest = client.load();
    const staleRejection = expect(staleRequest).rejects.toThrow('was invalidated');
    await expect(client.retry()).resolves.toMatchObject({ latest: null });
    await staleRejection;

    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('never permanently caches an HTTP failure', async () => {
    const fetchManifest = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(UNPUBLISHED_MANIFEST));
    const client = createReleaseManifestClient({ fetch: fetchManifest });

    await expect(client.load()).rejects.toThrow('HTTP 503');
    await expect(client.load()).resolves.toMatchObject({ latest: null });
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('surfaces invalid JSON and manifest validation errors distinctly', async () => {
    const invalidJsonClient = createReleaseManifestClient({
      fetch: vi.fn(async () => new Response('{', { status: 200 })),
    });
    await expect(invalidJsonClient.load()).rejects.toThrow('not valid JSON');

    const invalidManifestClient = createReleaseManifestClient({
      fetch: vi.fn(async () => jsonResponse({ ...UNPUBLISHED_MANIFEST, schemaVersion: 99 })),
    });
    await expect(invalidManifestClient.load()).rejects.toThrow('validation failed');
  });

  it('aborts and surfaces a request timeout', async () => {
    vi.useFakeTimers();
    const fetchManifest = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const client = createReleaseManifestClient({ fetch: fetchManifest, timeoutMs: 50 });

    const request = client.load();
    const rejection = expect(request).rejects.toThrow('timed out after 50ms');
    await vi.advanceTimersByTimeAsync(51);

    await rejection;
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    const response = {
      json: async () => new Promise<never>(() => undefined),
      ok: true,
      status: 200,
    } as unknown as Response;
    const client = createReleaseManifestClient({
      fetch: vi.fn(async () => response),
      timeoutMs: 50,
    });

    const request = client.load();
    const rejection = expect(request).rejects.toThrow('timed out after 50ms');
    await vi.advanceTimersByTimeAsync(51);

    await rejection;
  });

  it.each([
    ['https://downloads.example.com/release.json'],
    ['//downloads.example.com/release.json'],
    ['/release.json?channel=stable'],
    ['/release.json#latest'],
  ])('rejects a manifest path that is not an unambiguous same-origin path', (path) => {
    expect(() => createReleaseManifestClient({ path })).toThrow('same-origin path');
  });
});
