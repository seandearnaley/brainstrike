import { describe, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';

const SESSION_ID = 'held-delete-session';

interface ObservedDelete {
  readonly sessionId: string | null;
  readonly signal: AbortSignal | null | undefined;
}

/**
 * A Streamable HTTP server that opens a session and never answers its DELETE,
 * as a wedged or unreachable remote does.
 */
function heldDeleteServer() {
  const deletes: ObservedDelete[] = [];
  const fetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method === 'DELETE') {
      deletes.push({
        sessionId: new Headers(init?.headers).get('mcp-session-id'),
        signal: init?.signal,
      });
      return new Promise<Response>(() => undefined);
    }
    if (method === 'GET') {
      return new Response(null, { status: 405 });
    }
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (message.method === 'initialize') {
      return Response.json(
        {
          id: message.id,
          jsonrpc: '2.0',
          result: {
            capabilities: { tools: {} },
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'held-delete', version: '1.0.0' },
          },
        },
        { headers: { 'mcp-session-id': SESSION_ID } }
      );
    }
    return new Response(null, { status: 202 });
  };
  return { deletes, fetch };
}

describe('Explicit HTTP MCP session termination', () => {
  it('closes while the server has not answered the session DELETE, which stays in flight', async () => {
    const server = heldDeleteServer();
    const client = new ExplicitHttpMcpClient({
      fetch: server.fetch,
      name: 'held-delete',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
    });
    await client.connect();

    await expect(client.close()).resolves.toBeUndefined();

    expect(server.deletes).toHaveLength(1);
    expect(server.deletes[0]?.sessionId).toBe(SESSION_ID);
    // Closing the local client never cancels the farewell the server is owed.
    expect(server.deletes[0]?.signal?.aborted ?? false).toBe(false);
  });
});
