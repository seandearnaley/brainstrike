import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

let port = 0;
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
const encoder = new TextEncoder();

describe('mcp-clients (sse progress)', () => {
  beforeAll(async () => {
    port = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method ?? 'GET';

      if (method === 'POST' && url.endsWith('/request')) {
        try {
          const body = typeof init?.body === 'string' ? init.body : '';
          const parsed = JSON.parse(body) as { id: string; tool: string };
          setTimeout(() => {
            const progressPayload = encoder.encode(
              [
                'event: tool-progress',
                `id: ${parsed.id}`,
                `data: ${JSON.stringify({ id: parsed.id, step: 'starting' })}`,
                '',
                '',
              ].join('\n')
            );
            const resultPayload = encoder.encode(
              [
                'event: tool-result',
                `id: ${parsed.id}`,
                `data: ${JSON.stringify({ id: parsed.id, result: { ok: true } })}`,
                '',
                '',
              ].join('\n')
            );
            streams.forEach((controller) => {
              controller.enqueue(progressPayload);
              controller.enqueue(resultPayload);
            });
          }, 5);
          return new Response('accepted', { status: 202 });
        } catch {
          return new Response('bad json', { status: 400 });
        }
      }

      if (method === 'GET' && url.endsWith('/sse')) {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            // Remove any controllers that were registered for this stream
            streams.splice(0, streams.length);
          },
          start(controller) {
            controller.enqueue(encoder.encode(': ok\n\n'));
            streams.push(controller);
          },
        });
        return new Response(stream, {
          headers: {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream',
          },
          status: 200,
        });
      }

      return new Response('not found', { status: 404 });
    });
  });

  afterAll(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  afterEach(async () => {
    await disposeClients();
  });

  test('invokes onProgress callback before result', async () => {
    initClients({
      servers: [{ name: 'web', transport: 'sse', url: `http://127.0.0.1:${port}/sse` }],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();
    const seen: unknown[] = [];
    const res = await (client as NonNullable<typeof client>).callTool(
      'web.echo',
      { text: 'hi' },
      {
        onProgress: (payload) => seen.push(payload),
      }
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(res).toBeTruthy();
  });
});
