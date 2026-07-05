import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHfTargetUrl, handleHfProxyRequest, isAllowedHfDevPath } from '../hf-dev-proxy';

const fetchMock = vi.fn<typeof fetch>();

/**
 * Minimal ServerResponse double for testing middleware handlers.
 * Captures writeHead, write, and end calls for assertions.
 */
class ResponseSink extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      this.headers = { ...this.headers, ...headers };
    }
    return this;
  }

  write(chunk: string | Buffer | Uint8Array): boolean {
    if (typeof chunk === 'string') {
      this.chunks.push(chunk);
    } else {
      this.chunks.push(new TextDecoder().decode(chunk));
    }
    return true;
  }

  end(chunk?: string | Buffer | Uint8Array): this {
    if (chunk) {
      this.write(chunk);
    }
    this.ended = true;
    this.emit('finish');
    return this;
  }

  body(): string {
    return this.chunks.join('');
  }
}

function createMockRequest(
  url: string,
  options?: { method?: string; headers?: Record<string, string>; trustedSignal?: boolean }
): http.IncomingMessage {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    url,
    method: options?.method ?? 'GET',
    headers: {
      ...(options?.trustedSignal === false ? {} : { 'sec-fetch-site': 'same-origin' }),
      ...(options?.headers ?? {}),
    },
  }) as unknown as http.IncomingMessage;
}

/**
 * Streaming fetch mock faithful to real fetch: aborting the request signal
 * ERRORS the response body stream (that is exactly how a timed-out proxy
 * truncates a model download in the field).
 */
function createStreamingFetchMock(
  chunks: string[],
  intervalMs: number,
  options?: { stayOpen?: boolean }
): { getSignal: () => AbortSignal | undefined } {
  let capturedSignal: AbortSignal | undefined;
  fetchMock.mockImplementation((_url, init) => {
    capturedSignal = init?.signal ?? undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let settled = false;
        capturedSignal?.addEventListener(
          'abort',
          () => {
            if (!settled) {
              settled = true;
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            }
          },
          { once: true }
        );
        let index = 0;
        const pump = (): void => {
          if (settled) {
            return;
          }
          if (index >= chunks.length) {
            if (!options?.stayOpen) {
              settled = true;
              controller.close();
            }
            return;
          }
          controller.enqueue(encoder.encode(chunks[index] ?? ''));
          index += 1;
          setTimeout(pump, intervalMs);
        };
        setTimeout(pump, intervalMs);
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
  });
  return { getSignal: () => capturedSignal };
}

describe('hf dev proxy', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  describe('isAllowedHfDevPath', () => {
    it('allows the pinned gemma model resolve path', () => {
      expect(
        isAllowedHfDevPath(
          '/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json'
        )
      ).toBe(true);
    });

    it('allows nested ONNX model files', () => {
      expect(
        isAllowedHfDevPath(
          '/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/onnx/decoder_model_merged_q4f16.onnx'
        )
      ).toBe(true);
    });

    it('rejects paths to other models', () => {
      expect(isAllowedHfDevPath('/other-org/evil-model/resolve/main/config.json')).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(
        isAllowedHfDevPath(
          '/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/../../etc/passwd'
        )
      ).toBe(false);
    });

    it('allows main revision (used by transformers.js tokenizer discovery)', () => {
      expect(
        isAllowedHfDevPath('/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/tokenizer_config.json')
      ).toBe(true);
    });

    it('rejects percent-encoded path traversal (%2e%2e)', () => {
      expect(
        isAllowedHfDevPath('/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/%2e%2e/%2e%2e/secret')
      ).toBe(false);
    });

    it('rejects malformed percent-encoded paths without throwing', () => {
      expect(() =>
        isAllowedHfDevPath('/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/%E0%A4%A')
      ).not.toThrow();
      expect(isAllowedHfDevPath('/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/%E0%A4%A')).toBe(
        false
      );
    });

    it('rejects empty path', () => {
      expect(isAllowedHfDevPath('')).toBe(false);
    });
  });

  describe('buildHfTargetUrl', () => {
    it('constructs the full HuggingFace URL from a path', () => {
      expect(
        buildHfTargetUrl(
          '/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json'
        )
      ).toBe(
        'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json'
      );
    });
  });

  describe('handleHfProxyRequest', () => {
    it('proxies a valid request to HuggingFace and returns raw file content', async () => {
      const bodyContent = JSON.stringify({ image_processor_type: 'Gemma4ImageProcessor' });
      fetchMock.mockResolvedValue(
        new Response(bodyContent, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(bodyContent.length),
            etag: '"abc123"',
          },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json',
        { headers: { accept: '*/*' } }
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [targetUrl] = fetchMock.mock.calls[0] ?? [];
      expect(targetUrl).toBe(
        'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['etag']).toBe('"abc123"');
      expect(res.ended).toBe(true);
      expect(res.body()).toBe(bodyContent);
    });

    it('follows redirects via fetch (returns final content, not 307)', async () => {
      // Node's fetch() follows redirects automatically.
      // This test verifies we get the final 200 response, not the 307 redirect.
      const finalContent = '{"image_processor_type": "Gemma4ImageProcessor"}';
      fetchMock.mockResolvedValue(
        new Response(finalContent, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(finalContent.length),
          },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/preprocessor_config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      // The response MUST be 200 with content, NOT a 307 redirect
      expect(res.statusCode).toBe(200);
      expect(res.body()).toBe(finalContent);
      expect(res.headers['content-type']).toBe('application/json');
      // Verify the content is valid JSON (not HTML)
      expect(() => JSON.parse(res.body())).not.toThrow();
    });

    it('forwards accept and conditional headers from the original request', async () => {
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json',
        {
          headers: {
            accept: 'application/octet-stream',
            'if-none-match': '"etag-value"',
            'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
            range: 'bytes=0-1023',
          },
        }
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0] ?? [];
      const headers = options?.headers as Headers;
      expect(headers.get('accept')).toBe('application/octet-stream');
      expect(headers.get('if-none-match')).toBe('"etag-value"');
      expect(headers.get('if-modified-since')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
      expect(headers.get('range')).toBe('bytes=0-1023');
      expect(headers.get('user-agent')).toBe('brainstrike-local-llm');
    });

    it('defaults to accept */* when the request omits an accept header', async () => {
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      const [, options] = fetchMock.mock.calls[0] ?? [];
      const headers = options?.headers as Headers;
      expect(headers.get('accept')).toBe('*/*');
    });

    it('rejects requests for non-allowed model paths with 403', async () => {
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest('/api/hf/evil-org/evil-model/resolve/main/config.json');
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.ended).toBe(true);
    });

    it('rejects cross-site browser requests before proxying to Hugging Face', async () => {
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/config.json',
        {
          headers: {
            host: 'localhost:8080',
            origin: 'https://attacker.example',
            'sec-fetch-site': 'cross-site',
          },
        }
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body()).toBe('Forbidden Hugging Face proxy request.');
    });

    it('rejects requests without a trusted browser signal before proxying', async () => {
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/config.json',
        { trustedSignal: false }
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('returns 502 when the upstream fetch throws', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(res.statusCode).toBe(502);
      expect(res.ended).toBe(true);
    });

    it('sets immutable cache-control on 200 responses without existing cache header', async () => {
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('sets no-store cache-control on non-ok responses', async () => {
      fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/missing.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('preserves existing cache-control from upstream', async () => {
      fetchMock.mockResolvedValue(
        new Response('ok', {
          status: 200,
          headers: { 'cache-control': 'public, max-age=60' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('handles HEAD requests', async () => {
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-length': '12345', etag: '"head-test"' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json',
        { method: 'HEAD' }
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      const [, options] = fetchMock.mock.calls[0] ?? [];
      expect(options?.method).toBe('HEAD');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe('12345');
      expect(res.headers['etag']).toBe('"head-test"');
      expect(res.ended).toBe(true);
    });

    it('rejects path traversal in allowed model prefix', async () => {
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/../../etc/passwd'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('passes an AbortSignal with a timeout to the upstream fetch', async () => {
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      const [, options] = fetchMock.mock.calls[0] ?? [];
      expect((options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });

    it('completes transfers longer than the inactivity window while chunks keep arriving', async () => {
      // Model shards are multi-GB: a wall-clock ceiling on the whole transfer
      // truncates them mid-stream, which the browser reports as
      // ERR_CONTENT_LENGTH_MISMATCH and transformers.js surfaces as an
      // unhandled "network error". The timeout must be an INACTIVITY window.
      createStreamingFetchMock(['a;', 'b;', 'c;', 'd;', 'e;'], 25);
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/onnx/decoder_model_merged_q4f16.onnx_data'
      );
      const res = new ResponseSink();
      // Total transfer ~150ms exceeds the 80ms window; each chunk gap (25ms)
      // stays inside it.
      await handleHfProxyRequest(req, res as unknown as http.ServerResponse, {
        inactivityTimeoutMs: 80,
      });

      expect(res.body()).toBe('a;b;c;d;e;');
      expect(res.ended).toBe(true);
      expect(res.destroyed).toBe(false);
    });

    it('aborts upstream and destroys the response when the stream goes silent', async () => {
      const { getSignal } = createStreamingFetchMock(['first;'], 10, { stayOpen: true });
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/onnx/decoder_model_merged_q4f16.onnx_data'
      );
      const res = new ResponseSink();
      await expect(
        handleHfProxyRequest(req, res as unknown as http.ServerResponse, {
          inactivityTimeoutMs: 60,
        })
      ).rejects.toThrow();

      expect(getSignal()?.aborted).toBe(true);
      // Headers were already sent: a clean end() would silently truncate the
      // payload against its content-length; the socket must be killed instead.
      expect(res.destroyed).toBe(true);
      expect(res.ended).toBe(false);
    });

    it('waits for drain when res.write returns false (backpressure)', async () => {
      const bodyContent = 'chunk-data';
      fetchMock.mockResolvedValue(
        new Response(bodyContent, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const req = createMockRequest(
        '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/30b3854c1ca3e0f08981e1a439de9fbd9245a3a9/config.json'
      );
      const res = new ResponseSink();
      // Simulate backpressure: write returns false
      let drainCallback: (() => void) | null = null;
      res.write = (chunk: string | Buffer | Uint8Array) => {
        if (typeof chunk === 'string') {
          res.chunks.push(chunk);
        } else {
          res.chunks.push(new TextDecoder().decode(chunk));
        }
        // Resolve drain on next tick
        setTimeout(() => drainCallback?.(), 0);
        return false; // signal backpressure
      };
      res.once = ((event: string, cb: () => void) => {
        if (event === 'drain') {
          drainCallback = cb;
        }
        return res;
      }) as typeof res.once;

      await handleHfProxyRequest(req, res as unknown as http.ServerResponse);

      expect(res.ended).toBe(true);
      expect(res.body()).toBe(bodyContent);
    });
  });
});
