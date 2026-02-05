import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp';

let server: http.Server;
let port = 0;
const streams: http.ServerResponse[] = [];

describe('mcp-clients (sse progress)', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/request')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { id: string; tool: string };
            setTimeout(() => {
              // progress
              streams.forEach((s) => {
                s.write('event: tool-progress\n');
                s.write(`id: ${parsed.id}\n`);
                s.write(`data: ${JSON.stringify({ id: parsed.id, step: 'starting' })}\n\n`);
              });
              // result
              streams.forEach((s) => {
                s.write('event: tool-result\n');
                s.write(`id: ${parsed.id}\n`);
                s.write(`data: ${JSON.stringify({ id: parsed.id, result: { ok: true } })}\n\n`);
              });
            }, 5);
            res.writeHead(202);
            res.end('accepted');
          } catch {
            res.writeHead(400);
            res.end('bad json');
          }
        });
        return;
      }
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
          if (idx >= 0) {
            streams.splice(idx, 1);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address();
    if (typeof addr === 'object' && addr && 'port' in addr) {
      port = addr.port as number;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await disposeClients();
  });

  test('invokes onProgress callback before result', async () => {
    initClients({
      servers: [{ transport: 'sse', name: 'web', url: `http://127.0.0.1:${port}/sse` }],
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
