import { InMemoryResponseCacheStore, SdkErrorCode } from '@modelcontextprotocol/client';
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

  it('preserves exact pagination for resources, templates, and prompts', async () => {
    const requested: Array<{ cursor?: string; method: string }> = [];
    client = new ExplicitHttpMcpClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as {
          id?: number;
          method?: string;
          params?: { cursor?: string };
        };
        if (body.method === 'server/discover') {
          return Response.json({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              cacheScope: 'private',
              capabilities: { completions: {}, prompts: {}, resources: {}, tools: {} },
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              ttlMs: 0,
            },
          });
        }
        const method = body.method ?? '';
        requested.push({
          ...(body.params?.cursor === undefined ? {} : { cursor: body.params.cursor }),
          method,
        });
        const secondPage = body.params?.cursor === 'page-2';
        const common = {
          cacheScope: 'private',
          resultType: 'complete',
          ttlMs: 5000,
          ...(secondPage ? {} : { nextCursor: 'page-2' }),
        };
        const result =
          method === 'resources/list'
            ? {
                ...common,
                resources: [
                  {
                    name: secondPage ? 'second-resource' : 'first-resource',
                    uri: `fixture://resource/${secondPage ? '2' : '1'}`,
                  },
                ],
              }
            : method === 'resources/templates/list'
              ? {
                  ...common,
                  resourceTemplates: [
                    {
                      name: secondPage ? 'second-template' : 'first-template',
                      uriTemplate: `fixture://template/${secondPage ? '2' : '1'}/{id}`,
                    },
                  ],
                }
              : {
                  ...common,
                  prompts: [{ name: secondPage ? 'second-prompt' : 'first-prompt' }],
                };
        return Response.json({ id: body.id, jsonrpc: '2.0', result });
      },
      name: 'core-pagination-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://pagination.invalid/mcp',
    });

    await expect(client.listResources()).resolves.toMatchObject({
      cacheScope: 'private',
      resources: [{ name: 'first-resource' }, { name: 'second-resource' }],
      ttlMs: 5000,
    });
    await expect(client.listResourceTemplates()).resolves.toMatchObject({
      resourceTemplates: [{ name: 'first-template' }, { name: 'second-template' }],
    });
    await expect(client.listPrompts()).resolves.toMatchObject({
      prompts: [{ name: 'first-prompt' }, { name: 'second-prompt' }],
    });
    await expect(client.listResources(undefined, { cursor: 'page-2' })).resolves.toMatchObject({
      resources: [{ name: 'second-resource' }],
    });
    expect(requested).toEqual([
      { method: 'resources/list' },
      { cursor: 'page-2', method: 'resources/list' },
      { method: 'resources/templates/list' },
      { cursor: 'page-2', method: 'resources/templates/list' },
      { method: 'prompts/list' },
      { cursor: 'page-2', method: 'prompts/list' },
      { cursor: 'page-2', method: 'resources/list' },
    ]);
  });

  it('isolates private resource bodies by principal while honoring ttlMs and cacheScope', async () => {
    const store = new InMemoryResponseCacheStore();
    let reads = 0;
    const createClient = (principal: string) =>
      new ExplicitHttpMcpClient({
        cachePartition: principal,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request.json()) as { id?: number; method?: string };
          if (body.method === 'server/discover') {
            return Response.json({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                _meta: {
                  'io.modelcontextprotocol/serverInfo': {
                    name: 'shared-resource-server',
                    version: '1',
                  },
                },
                cacheScope: 'private',
                capabilities: { resources: {} },
                resultType: 'complete',
                supportedVersions: ['2026-07-28'],
                ttlMs: 0,
              },
            });
          }
          reads += 1;
          return Response.json({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              cacheScope: 'private',
              contents: [{ text: principal, uri: 'fixture://private' }],
              resultType: 'complete',
              ttlMs: 60_000,
            },
          });
        },
        name: `private-resource-${principal}`,
        protocol: '2026-07-28',
        responseCacheStore: store,
        transport: 'streamable-http',
        url: 'https://private-resource.invalid/mcp',
      });
    const alice = createClient('alice');
    const bob = createClient('bob');
    try {
      await expect(alice.readResource({ uri: 'fixture://private' })).resolves.toMatchObject({
        cacheScope: 'private',
        contents: [{ text: 'alice' }],
        ttlMs: 60_000,
      });
      await expect(bob.readResource({ uri: 'fixture://private' })).resolves.toMatchObject({
        contents: [{ text: 'bob' }],
      });
      await expect(alice.readResource({ uri: 'fixture://private' })).resolves.toMatchObject({
        contents: [{ text: 'alice' }],
      });
      expect(reads).toBe(2);
    } finally {
      await Promise.allSettled([alice.close(), bob.close()]);
    }
  });
});
