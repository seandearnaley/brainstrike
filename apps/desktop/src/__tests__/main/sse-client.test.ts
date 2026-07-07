import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseClient } from '../../mcp/sse-client';

function createControlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  return { controller: () => controller, stream };
}

describe('sse-client', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('resolves tool results from SSE events', async () => {
    const { stream, controller } = createControlledStream();
    const fetchMock = vi.fn();
    let requestId = '';

    fetchMock
      .mockResolvedValueOnce({ body: stream, ok: true }) // events stream
      .mockImplementationOnce(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        requestId = body.id as string;
        return { ok: true, status: 200 };
      });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createSseClient({
      headers: { Authorization: 'Bearer token' },
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/sse',
    });

    const promise = client.callTool('remote.search', { query: 'hello' });

    const deadline = Date.now() + 500;
    while (!requestId) {
      if (Date.now() > deadline) {
        throw new Error('requestId not captured');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const encoder = new TextEncoder();
    const frame = `id: ${requestId}\nevent: tool-result\ndata: {"result": {"ok": true}}\n\n`;
    controller()?.enqueue(encoder.encode(frame));
    controller()?.close();

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('falls back to call path when request returns non-ok', async () => {
    process.env['MCP_SSE_CALL_PATH'] = '/call';

    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: false }) // events stream fails (ignored)
      .mockResolvedValueOnce({ ok: false, status: 500 }) // request path fails
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, via: 'fallback' }),
        ok: true,
      });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createSseClient({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.com/sse',
    });

    await expect(client.callTool('remote.search', { query: 'fallback' })).resolves.toEqual({
      ok: true,
      via: 'fallback',
    });
  });
});
