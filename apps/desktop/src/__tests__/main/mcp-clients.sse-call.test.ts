import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

let port = 0;
type ToolRequest = Parameters<typeof emitToolResult>[0];
type StreamList = ReadableStreamDefaultController<Uint8Array>[];
let requestInterceptor: ((parsed: ToolRequest, streams: StreamList) => void) | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
const encoder = new TextEncoder();

function emitToolResult(
  parsed: { id: string; tool: string; params?: { text?: string } },
  streams: ReadableStreamDefaultController<Uint8Array>[]
): void {
  try {
    // Emit a progress event first
    const progressPayload = encoder.encode(
      [
        'event: tool-progress',
        `id: ${parsed.id}`,
        `data: ${JSON.stringify({ id: parsed.id, step: 'starting' })}`,
        '',
        '',
      ].join('\n')
    );
    for (const controller of streams) {
      controller.enqueue(progressPayload);
    }
    // Emit a tool-result event with the same id and a result payload
    if (streams.length > 0) {
      const line =
        'event: tool-result\n' +
        `id: ${parsed.id}\n` +
        `data: ${JSON.stringify({ id: parsed.id, result: { echo: parsed.params?.text ?? null, tool: parsed.tool } })}\n\n`;
      const resultPayload = encoder.encode(line);
      for (const controller of streams) {
        controller.enqueue(resultPayload);
      }
    }
  } catch {}
}

describe('mcp-clients (sse request/response)', () => {
  beforeAll(async () => {
    port = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method ?? 'GET';

      if (method === 'POST' && url.endsWith('/request')) {
        try {
          const body = typeof init?.body === 'string' ? init.body : '';
          const parsed = JSON.parse(body) as ToolRequest;
          const handler =
            requestInterceptor ??
            ((req: ToolRequest, resStreams: StreamList): void => {
              setTimeout(() => emitToolResult(req, resStreams), 10);
            });
          handler(parsed, streams);
          return new Response('accepted', { status: 202 });
        } catch {
          return new Response('bad json', { status: 400 });
        }
      }

      if (method === 'GET' && url.endsWith('/sse')) {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
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
    requestInterceptor = undefined;
  });

  const streams: StreamList = [];

  test('Sends request and resolves with SSE tool-result payload', async () => {
    initClients({
      servers: [
        {
          headers: {},
          name: 'web',
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
        },
      ],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();
    const res = (await client?.callTool('web.echo', { text: 'hello' })) as {
      echo: string | null;
      tool: string;
    };
    expect(res).toMatchObject({ echo: 'hello', tool: 'web.echo' });
  });

  test('Resolves with error object on tool-error event', async () => {
    requestInterceptor = (parsed, activeStreams) => {
      setTimeout(() => {
        const line =
          'event: tool-error\n' +
          `id: ${parsed.id}\n` +
          `data: ${JSON.stringify({ error: 'failed', id: parsed.id })}\n\n`;
        const payload = encoder.encode(line);
        for (const controller of activeStreams) {
          controller.enqueue(payload);
        }
      }, 5);
    };
    // Emit an error for a new request id
    initClients({
      servers: [
        { headers: {}, name: 'web', transport: 'sse', url: `http://127.0.0.1:${port}/sse` },
      ],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();

    const p = (client as NonNullable<typeof client>).callTool('web.echo', { text: 'boom' });
    const res = (await p) as { error?: string };
    expect(res && 'error' in res).toBe(true);
  });
});
