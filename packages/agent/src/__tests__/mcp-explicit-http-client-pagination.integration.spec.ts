import { SdkErrorCode } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';

describe('ExplicitHttpMcpClient pagination policy', () => {
  let client: ExplicitHttpMcpClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
  });

  it('fails a non-converging automatic list walk at the finite host cap', async () => {
    let nextCursor = 0;
    client = new ExplicitHttpMcpClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { id?: number; method?: string };
        if (body.method === 'server/discover') {
          return Response.json({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              _meta: {
                'io.modelcontextprotocol/serverInfo': { name: 'pagination-server', version: '1' },
              },
              cacheScope: 'private',
              capabilities: { tools: {} },
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              ttlMs: 0,
            },
          });
        }
        if (body.method !== 'tools/list') {
          return Response.json({ id: body.id, jsonrpc: '2.0', result: {} });
        }
        nextCursor += 1;
        return Response.json({
          id: body.id,
          jsonrpc: '2.0',
          result: {
            cacheScope: 'private',
            nextCursor: `page-${nextCursor}`,
            resultType: 'complete',
            tools: [{ inputSchema: { type: 'object' }, name: `tool-${nextCursor}` }],
            ttlMs: 0,
          },
        });
      },
      listMaxPages: 1,
      name: 'pagination-cap-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://pagination.invalid/mcp',
    });

    await expect(client.listTools()).rejects.toMatchObject({
      code: SdkErrorCode.ListPaginationExceeded,
      data: { listMaxPages: 1, method: 'tools/list' },
    });
    expect(nextCursor).toBe(1);
  });
});
