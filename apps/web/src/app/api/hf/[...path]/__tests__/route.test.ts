import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '../route';

const fetchMock = vi.fn<typeof fetch>();

describe('hf proxy route', () => {
  function createTrustedRequest(url: string, init?: RequestInit): Request {
    const origin = new URL(url).origin;
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    return {
      headers,
      method: init?.method ?? 'GET',
      referrer: `${origin}/app`,
      signal: init?.signal ?? new AbortController().signal,
      url,
    } as Request;
  }

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('proxies the request to Hugging Face with preserved headers', async () => {
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ok'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(
      new Response(upstreamBody, {
        headers: {
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=60',
          'content-length': '2',
          'content-range': 'bytes 0-1/2',
          'content-type': 'application/octet-stream',
          etag: '"abc"',
        },
        status: 206,
        statusText: 'Partial Content',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = createTrustedRequest(
      'https://brainstrike.example/api/hf/models/gemma?download=true',
      {
        headers: {
          accept: 'application/octet-stream',
          'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
          'if-none-match': '"abc"',
          range: 'bytes=0-1',
        },
        method: 'GET',
      }
    );

    const response = await GET(request, {
      params: Promise.resolve({
        path: [
          'onnx-community',
          'gemma-4-E2B-it-ONNX',
          'resolve',
          '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
          'onnx',
          'decoder_model_merged_q4f16.onnx',
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] ?? [];
    expect(targetUrl).toBe(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/onnx/decoder_model_merged_q4f16.onnx'
    );
    expect(options).toMatchObject({ method: 'GET' });
    const headers = options?.headers as Headers;
    expect(headers.get('accept')).toBe('application/octet-stream');
    expect(headers.get('if-modified-since')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(headers.get('if-none-match')).toBe('"abc"');
    expect(headers.get('range')).toBe('bytes=0-1');
    expect(headers.get('user-agent')).toBe('brainstrike-local-llm');
    expect((options as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect((options as { signal: AbortSignal }).signal).toBe(request.signal);
    expect(response.status).toBe(206);
    expect(response.statusText).toBe('Partial Content');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1/2');
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(await response.text()).toBe('ok');
  });

  it('falls back to a permissive accept header when the request omits one', async () => {
    fetchMock.mockResolvedValue(new Response('fallback', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      createTrustedRequest('https://brainstrike.example/api/hf/models/gemma'),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'foo bar',
          ],
        }),
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] ?? [];
    expect(targetUrl).toBe(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/foo%20bar'
    );
    const headers = options?.headers as Headers;
    expect(headers.get('accept')).toBe('*/*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('rejects requests for unsupported models', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(createTrustedRequest('http://localhost/api/hf/other/model'), {
      params: Promise.resolve({
        path: ['other-org', 'other-model', 'resolve', 'main'],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('marks transient upstream errors as non-cacheable', async () => {
    fetchMock.mockResolvedValue(
      new Response('busy', {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        status: 503,
        statusText: 'Busy',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      createTrustedRequest('https://brainstrike.example/api/hf/models/gemma'),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'config.json',
          ],
        }),
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects traversal segments even when the allowlisted model prefix matches', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      createTrustedRequest(
        'http://localhost/api/hf/onnx-community/gemma-4-E2B-it-ONNX/../../evil/model'
      ),
      {
        params: Promise.resolve({
          path: ['onnx-community', 'gemma-4-E2B-it-ONNX', '..', '..', 'evil-org', 'evil-model'],
        }),
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('propagates the incoming request abort signal to the upstream fetch', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const request = createTrustedRequest('https://brainstrike.example/api/hf/models/gemma', {
      method: 'GET',
      signal: controller.signal,
    });
    controller.abort();

    await GET(request, {
      params: Promise.resolve({
        path: [
          'onnx-community',
          'gemma-4-E2B-it-ONNX',
          'resolve',
          '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
          'config.json',
        ],
      }),
    }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect((options as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('supports HEAD not-modified metadata probes', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'cache-control': 'public, max-age=60',
          etag: '"head-etag"',
        },
        status: 304,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await HEAD(
      createTrustedRequest('https://brainstrike.example/api/hf/models/gemma', {
        method: 'HEAD',
      }),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'config.json',
          ],
        }),
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({ method: 'HEAD' });
    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('etag')).toBe('"head-etag"');
    expect(await response.text()).toBe('');
  });

  it('rejects requests that do not present a trusted same-origin browser signal', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('https://brainstrike.example/api/hf/models/gemma'), {
      params: Promise.resolve({
        path: [
          'onnx-community',
          'gemma-4-E2B-it-ONNX',
          'resolve',
          '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
          'config.json',
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(response.headers.get('x-brainstrike-proxy-rejection')).toBe('origin');
    expect(await response.text()).toContain('Forbidden Hugging Face proxy request');
  });

  it('does not trust a localhost host header bypass without same-origin browser signals', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request('http://localhost/api/hf/models/gemma', {
        headers: {
          host: 'localhost',
        },
      }),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'config.json',
          ],
        }),
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('rejects decoded path segments that still contain slash characters', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      createTrustedRequest(
        'https://brainstrike.example/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/path'
      ),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'onnx/embed_tokens_q4f16.onnx',
          ],
        }),
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('returns a controlled upstream error when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      createTrustedRequest('https://brainstrike.example/api/hf/models/gemma'),
      {
        params: Promise.resolve({
          path: [
            'onnx-community',
            'gemma-4-E2B-it-ONNX',
            'resolve',
            '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
            'config.json',
          ],
        }),
      }
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Failed to reach Hugging Face upstream');
  });
});
