import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

let server: http.Server;
let port = 0;

function emitToolResult(
  parsed: { id: string; tool: string; params?: { text?: string } },
  streams: http.ServerResponse[]
): void {
  try {
    // Emit a progress event first
    for (const s of streams) {
      s.write('event: tool-progress\n');
      s.write(`id: ${parsed.id}\n`);
      s.write(`data: ${JSON.stringify({ id: parsed.id, step: 'starting' })}\n\n`);
    }
    // Emit a tool-result event with the same id and a result payload
    if (streams.length > 0) {
      const line =
        'event: tool-result\n' +
        `id: ${parsed.id}\n` +
        `data: ${JSON.stringify({ id: parsed.id, result: { echo: parsed.params?.text ?? null, tool: parsed.tool } })}\n\n`;
      for (const s of streams) {
        s.write(line);
      }
    }
  } catch {}
}

describe('mcp-clients (sse request/response)', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/request')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              id: string;
              tool: string;
              params?: { text?: string };
            };
            // stash to echo later on the SSE stream
            setTimeout(() => emitToolResult(parsed, streams), 10);
            res.writeHead(202);
            res.end('accepted');
          } catch {
            res.writeHead(400);
            res.end('bad json');
          }
        });
        return;
      }
      // rudimentary sse endpoint
      if (req.method === 'GET' && req.url?.endsWith('/sse')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'Cache-Control': 'no-cache',
        });
        res.write(': ok\n\n');
        streams.push(res);
        req.on('close', () => {
          const idx = streams.indexOf(res);
          if (idx >= 0) streams.splice(idx, 1);
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address();
    if (typeof addr === 'object' && addr && 'port' in addr) port = addr.port as number;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await disposeClients();
  });

  const streams: http.ServerResponse[] = [];

  test('Sends request and resolves with SSE tool-result payload', async () => {
    initClients({
      servers: [
        {
          transport: 'sse',
          name: 'web',
          url: `http://127.0.0.1:${port}/sse`,
          headers: {},
        },
      ],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();
    const res = (await client?.callTool('web.echo', { text: 'hello' })) as {
      echo: string | null;
      tool: string;
    };
    expect(res).toMatchObject({ tool: 'web.echo', echo: 'hello' });
  });

  test('Resolves with error object on tool-error event', async () => {
    // Emit an error for a new request id
    initClients({
      servers: [
        { transport: 'sse', name: 'web', url: `http://127.0.0.1:${port}/sse`, headers: {} },
      ],
    });
    const client = getClient('web');
    expect(client).toBeTruthy();

    // Hijack server behavior: when request arrives, emit tool-error
    const p = (client as NonNullable<typeof client>).callTool('web.echo', { text: 'boom' });
    // Allow the client to connect and register pending id, then emit a generic error
    await new Promise((r) => setTimeout(r, 10));
    streams.forEach((s) => {
      const line = `event: tool-error\ndata: ${JSON.stringify({ error: 'failed' })}\n\n`;
      s.write(line);
    });
    const res = (await p) as { error?: string };
    expect(res && 'error' in res).toBe(true);
  });
});
