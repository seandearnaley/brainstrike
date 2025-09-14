import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { disposeClients, getClient, initClients } from '../../mcp-clients';

let server: http.Server;
let port = 0;

describe('mcp-clients (sse call)', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/call')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { tool?: string; params?: { text?: string } };
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(
              JSON.stringify({
                ok: true,
                tool: parsed.tool,
                echo: parsed.params?.text ?? null,
              })
            );
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
        setTimeout(() => {
          try {
            res.end();
          } catch {}
        }, 50);
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

  test('POST /call responds and client returns JSON', async () => {
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
      ok: boolean;
      tool: string;
      echo: string | null;
    };
    expect(res).toMatchObject({ ok: true, tool: 'web.echo', echo: 'hello' });
  });
});
