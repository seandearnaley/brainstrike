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
          'content-type': 'application/octet-stream',
          'content-length': '2',
          'cache-control': 'public, max-age=60',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost/api/hf/models/gemma', {
      headers: { accept: 'application/octet-stream' },
      method: 'GET',
    });

    const response = await GET(request, {
      params: Promise.resolve({
        path: ['onnx-community', 'gemma-4-E2B-it-ONNX', 'resolve', 'main'],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/octet-stream',
          'user-agent': 'brainstrike-local-llm',
        }),
        method: 'GET',
      })
    );
    expect(response.status).toBe(206);
    expect(response.statusText).toBe('Partial Content');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.text()).toBe('ok');
  });

  it('falls back to a permissive accept header when the request omits one', async () => {
    fetchMock.mockResolvedValue(new Response('fallback', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await GET(new Request('http://localhost/api/hf/models/gemma'), {
      params: Promise.resolve({ path: ['foo bar', 'baz?qux'] }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/foo%20bar/baz%3Fqux',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: '*/*',
        }),
      })
    );
  });
});
