import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthProvider } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

async function readJsonBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected one MCP request object');
  }
  return value as Readonly<Record<string, unknown>>;
}

describe('ExplicitHttpMcpClient host-owned auth', () => {
  it('performs exactly one bounded 401 retry with the refreshed bearer', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    const observedMethods: string[] = [];
    const server = createServer(async (request, response) => {
      const body = await readJsonBody(request);
      const method = body['method'];
      if (typeof method !== 'string') {
        response.writeHead(400).end();
        return;
      }
      observedAuthorization.push(request.headers.authorization);
      observedMethods.push(method);
      if (request.headers.authorization !== 'Bearer current-token') {
        response
          .writeHead(401, {
            'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/oauth-resource"',
          })
          .end();
        return;
      }
      if (method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: body['id'],
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'auth-test-server', version: '1.0.0' },
            },
          })
        );
        return;
      }
      response.writeHead(202).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    cleanupTasks.push(
      async () =>
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const address = server.address() as AddressInfo;
    let token = 'expired-token';
    let unauthorizedCalls = 0;
    const authProvider: AuthProvider = {
      async onUnauthorized() {
        unauthorizedCalls += 1;
        token = 'current-token';
      },
      async token() {
        return token;
      },
    };
    const client = new ExplicitHttpMcpClient({
      authProvider,
      name: 'host-owned-auth-canary',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    cleanupTasks.push(async () => await client.close());

    await client.connect();

    expect(unauthorizedCalls).toBe(1);
    expect(observedMethods).toEqual(['initialize', 'initialize', 'notifications/initialized']);
    expect(observedAuthorization).toEqual([
      'Bearer expired-token',
      'Bearer current-token',
      'Bearer current-token',
    ]);
  });
});
