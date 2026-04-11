import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

const fetchMock = vi.fn<typeof fetch>();

describe('hf proxy route', () => {
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
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'accept-ranges': 'bytes',
          'content-type': 'application/octet-stream',
          'content-length': '2',
          'cache-control': 'public, max-age=60',
          'content-range': 'bytes 0-1/2',
          etag: '"abc"',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost/api/hf/models/gemma?download=true', {
      headers: {
        accept: 'application/octet-stream',
        'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
        'if-none-match': '"abc"',
        range: 'bytes=0-1',
      },
      method: 'GET',
    });

    const response = await GET(request, {
      params: Promise.resolve({
        path: ['onnx-community', 'gemma-4-E2B-it-ONNX', 'resolve', 'main'],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] ?? [];
    expect(targetUrl).toBe(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main?download=true'
    );
    expect(options).toMatchObject({ method: 'GET' });
    const headers = options?.headers as Headers;
    expect(headers.get('accept')).toBe('application/octet-stream');
    expect(headers.get('if-modified-since')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(headers.get('if-none-match')).toBe('"abc"');
    expect(headers.get('range')).toBe('bytes=0-1');
    expect(headers.get('user-agent')).toBe('brainstrike-local-llm');
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

    await GET(new Request('http://localhost/api/hf/models/gemma'), {
      params: Promise.resolve({
        path: ['onnx-community', 'gemma-4-E2B-it-ONNX', 'resolve', 'main', 'foo bar'],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] ?? [];
    expect(targetUrl).toBe(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/foo%20bar'
    );
    const headers = options?.headers as Headers;
    expect(headers.get('accept')).toBe('*/*');
  });

  it('rejects requests for unsupported models', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/hf/other/model'), {
      params: Promise.resolve({
        path: ['other-org', 'other-model', 'resolve', 'main'],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
});
