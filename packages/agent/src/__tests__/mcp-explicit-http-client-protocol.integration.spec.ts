import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InMemoryResponseCacheStore,
  type InputRequiredResult,
  type ResponseCacheStore,
} from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  type ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
} from '../mcp/explicit-http-client';

interface RecordedRequest {
  body?: unknown;
  headers: IncomingMessage['headers'];
  method: string;
  pathname: string;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

async function listen(server: Server, pathname: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  cleanupTasks.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return `http://127.0.0.1:${address.port}${pathname}`;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function requestMethod(body: unknown): string | undefined {
  if (!(body && typeof body === 'object' && 'method' in body)) {
    return undefined;
  }
  return typeof body.method === 'string' ? body.method : undefined;
}

function trackClient(options: ExplicitHttpMcpClientOptions): ExplicitHttpMcpClient {
  const client = new ExplicitHttpMcpClient(options);
  cleanupTasks.push(() => client.close().catch(() => undefined));
  return client;
}

function modernResponse(id: unknown, result: unknown): Response {
  return Response.json({ id, jsonrpc: '2.0', result });
}

function createHeaderValidatingServer(): McpServer {
  const server = new McpServer({ name: 'header-validating-server', version: '1' });
  server.registerTool(
    'lookup',
    {
      description: 'Lookup by account',
      inputSchema: z.object({
        account: z.string().meta({ 'x-mcp-header': 'X-Account' }),
      }),
    },
    async () => ({ content: [{ text: 'ok', type: 'text' }] })
  );
  return server;
}

function assertInputRequiredCallToolTypes(client: ExplicitHttpMcpClient): void {
  const normal = client.callTool({ name: 'lookup' });
  const manual = client.callTool({ name: 'lookup' }, { allowInputRequired: true });

  expectTypeOf(normal).toEqualTypeOf<Promise<ExplicitHttpMcpCallToolResult>>();
  expectTypeOf(manual).toEqualTypeOf<
    Promise<ExplicitHttpMcpCallToolResult | InputRequiredResult>
  >();
}

describe('ExplicitHttpMcpClient protocol blockers', { timeout: 30_000 }, () => {
  it('defaults an absent resultType after real auto negotiation selects modern', async () => {
    const methods: string[] = [];
    const client = trackClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { id?: number; method?: string };
        if (body.method) {
          methods.push(body.method);
        }
        if (body.method === 'server/discover') {
          return modernResponse(body.id, {
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: 'auto-result-type-server',
                version: '1',
              },
            },
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        if (body.method === 'tools/list') {
          return modernResponse(body.id, {
            resultType: 'complete',
            tools: [
              {
                inputSchema: { additionalProperties: false, type: 'object' },
                name: 'missing-result-type',
              },
            ],
          });
        }
        if (body.method === 'tools/call') {
          return modernResponse(body.id, {
            content: [{ text: 'complete by compatibility rule', type: 'text' }],
          });
        }
        throw new Error(`Unexpected MCP method: ${String(body.method)}`);
      },
      name: 'auto-result-type-canary',
      protocol: 'auto',
      transport: 'streamable-http',
      url: 'https://auto-result-type.invalid/mcp',
    });

    await client.connect();
    await expect(
      client.callTool({ arguments: {}, name: 'missing-result-type' })
    ).resolves.toMatchObject({
      content: [{ text: 'complete by compatibility rule', type: 'text' }],
    });

    expect(client.getProtocolEra()).toBe('modern');
    expect(methods).toEqual(['server/discover', 'tools/call']);
  });

  it('isolates private catalog cache entries by principal on a shared store', async () => {
    const backingStore = new InMemoryResponseCacheStore();
    await backingStore.set(
      {
        method: 'tools/list',
        params: '',
        partition: JSON.stringify(['shared-cache-server@1', 'alice']),
      },
      {
        expiresAt: Date.now() + 60_000,
        scope: 'private',
        value: JSON.stringify({
          cacheScope: 'private',
          resultType: 'complete',
          tools: [{ inputSchema: { type: 'object' }, name: 'stale-tool' }],
          ttlMs: 60_000,
        }),
      }
    );
    const writtenPartitions: string[] = [];
    const sharedStore: ResponseCacheStore = {
      clear: () => backingStore.clear(),
      delete: (key) => backingStore.delete(key),
      evict: (method) => backingStore.evict(method),
      get: (key) => backingStore.get(key),
      set: (key, entry) => {
        writtenPartitions.push(key.partition ?? '');
        return backingStore.set(key, entry);
      },
    };
    const wireCounts = new Map<string, number>();
    const createClient = (principal: string): ExplicitHttpMcpClient =>
      trackClient({
        cachePartition: principal,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request
            .clone()
            .json()
            .catch(() => undefined)) as { id?: number; method?: string } | undefined;
          if (body?.method) {
            wireCounts.set(body.method, (wireCounts.get(body.method) ?? 0) + 1);
          }
          if (body?.method === 'server/discover') {
            return modernResponse(body.id, {
              _meta: {
                'io.modelcontextprotocol/serverInfo': {
                  name: 'shared-cache-server',
                  version: '1',
                },
              },
              capabilities: { tools: {} },
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
            });
          }
          return modernResponse(body?.id, {
            cacheScope: 'private',
            resultType: 'complete',
            tools: [
              {
                description: principal,
                inputSchema: { type: 'object' },
                name: `${principal}-tool`,
              },
            ],
            ttlMs: 60_000,
          });
        },
        name: `shared-cache-${principal}`,
        protocol: '2026-07-28',
        responseCacheStore: sharedStore,
        transport: 'streamable-http',
        url: 'https://shared-cache.invalid/mcp',
      });
    const alice = createClient('alice');
    const bob = createClient('bob');

    await alice.connect();
    await bob.connect();
    await expect(alice.listTools()).resolves.toMatchObject({ tools: [{ name: 'alice-tool' }] });
    await expect(bob.listTools()).resolves.toMatchObject({ tools: [{ name: 'bob-tool' }] });
    await expect(alice.listTools()).resolves.toMatchObject({ tools: [{ name: 'alice-tool' }] });

    expect(wireCounts.get('tools/list')).toBe(2);
    expect(new Set(writtenPartitions).size).toBe(2);
    expect(
      writtenPartitions.every(
        (partition) => partition.includes('alice') || partition.includes('bob')
      )
    ).toBe(true);
  });

  it('refreshes the tool catalog after a reconnect instead of serving a prior generation', async () => {
    const requests: RecordedRequest[] = [];
    let activeSession = 'session-1';
    let generation = 1;
    let expired = false;
    let tools: Array<{ description: string; inputSchema: { type: 'object' }; name: string }> = [
      { description: 'Old tool', inputSchema: { type: 'object' }, name: 'old-tool' },
    ];
    const client = trackClient({
      cachePartition: 'principal-a',
      defaultCacheTtlMs: 60_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request
          .clone()
          .json()
          .catch(() => undefined)) as { id?: number; method?: string } | undefined;
        requests.push({
          body,
          headers: Object.fromEntries(request.headers),
          method: request.method,
          pathname: request.url,
        });
        if (body?.method === 'initialize') {
          activeSession = `session-${generation}`;
          return new Response(
            JSON.stringify({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                capabilities: { tools: {} },
                protocolVersion: '2025-11-25',
                serverInfo: { name: 'generation-server', version: '1' },
              },
            }),
            { headers: { 'content-type': 'application/json', 'mcp-session-id': activeSession } }
          );
        }
        if (body?.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (body?.method === 'tools/call' && expired) {
          expired = false;
          generation += 1;
          return new Response('expired', { status: 404 });
        }
        if (body?.method === 'tools/list') {
          if (request.headers.get('mcp-session-id') !== activeSession) {
            return new Response('expired', { status: 404 });
          }
          return modernResponse(body.id, {
            cacheScope: 'private',
            resultType: 'complete',
            tools,
            ttlMs: 60_000,
          });
        }
        return modernResponse(body?.id, {
          content: [{ text: 'called', type: 'text' }],
          resultType: 'complete',
        });
      },
      name: 'generation-catalog-canary',
      responseCacheStore: new InMemoryResponseCacheStore(),
      transport: 'streamable-http',
      url: 'https://generation.invalid/mcp',
    });

    await client.connect();
    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'old-tool' }] });
    expired = true;
    tools = [{ description: 'New tool', inputSchema: { type: 'object' }, name: 'new-tool' }];

    await client.callTool({ name: 'old-tool' }).catch(() => undefined);
    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'new-tool' }] });
    expect(requests.filter((request) => requestMethod(request.body) === 'tools/list')).toHaveLength(
      2
    );
  });

  it('refreshes every positive-TTL catalog independently after reconnect', async () => {
    const wireCounts = new Map<string, number>();
    let generation = 1;
    let expired = false;
    let sessionId = 'session-1';
    const client = trackClient({
      cachePartition: 'catalog-principal',
      defaultCacheTtlMs: 60_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { id?: number; method?: string };
        if (body.method) {
          wireCounts.set(body.method, (wireCounts.get(body.method) ?? 0) + 1);
        }
        if (body.method === 'initialize') {
          sessionId = `session-${generation}`;
          return new Response(
            JSON.stringify({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                capabilities: { prompts: {}, resources: {}, tools: {} },
                protocolVersion: '2025-11-25',
                serverInfo: { name: 'catalog-server', version: '1' },
              },
            }),
            { headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId } }
          );
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (body.method === 'tools/call' && expired) {
          expired = false;
          generation += 1;
          return new Response('expired', { status: 404 });
        }
        if (request.headers.get('mcp-session-id') !== sessionId) {
          return new Response('expired', { status: 404 });
        }
        if (body.method === 'tools/list') {
          return modernResponse(body.id, {
            cacheScope: 'private',
            resultType: 'complete',
            tools: [{ inputSchema: { type: 'object' }, name: `tool-${generation}` }],
            ttlMs: 60_000,
          });
        }
        if (body.method === 'resources/list') {
          return modernResponse(body.id, {
            cacheScope: 'private',
            resources: [{ name: `resource-${generation}`, uri: `file:///resource-${generation}` }],
            resultType: 'complete',
            ttlMs: 60_000,
          });
        }
        if (body.method === 'resources/templates/list') {
          return modernResponse(body.id, {
            cacheScope: 'private',
            resourceTemplates: [
              {
                name: `template-${generation}`,
                uriTemplate: `file:///template-${generation}/{id}`,
              },
            ],
            resultType: 'complete',
            ttlMs: 60_000,
          });
        }
        if (body.method === 'prompts/list') {
          return modernResponse(body.id, {
            cacheScope: 'private',
            prompts: [{ name: `prompt-${generation}` }],
            resultType: 'complete',
            ttlMs: 60_000,
          });
        }
        return modernResponse(body.id, {
          content: [{ text: 'called', type: 'text' }],
          resultType: 'complete',
        });
      },
      name: 'all-catalog-generation-canary',
      responseCacheStore: new InMemoryResponseCacheStore(),
      transport: 'streamable-http',
      url: 'https://catalog-generation.invalid/mcp',
    });

    await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    expired = true;
    await client.callTool({ name: 'tool-1' });

    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);

    expect(tools.tools[0]?.name).toBe('tool-2');
    expect(resources.resources[0]?.name).toBe('resource-2');
    expect(templates.resourceTemplates[0]?.name).toBe('template-2');
    expect(prompts.prompts[0]?.name).toBe('prompt-2');
    for (const method of [
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
    ]) {
      expect(wireCounts.get(method)).toBe(2);
    }
  });

  it('routes roots changes through lifecycle recovery with only a pre-send abort check', async () => {
    let generation = 1;
    let rootsAttempts = 0;
    let sessionId = 'session-1';
    const inFlightAbort = new AbortController();
    const client = trackClient({
      clientCapabilities: {
        roots: { handle: async () => ({ roots: [] }), listChanged: true },
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { id?: number; method?: string };
        if (body.method === 'initialize') {
          sessionId = `session-${generation}`;
          return new Response(
            JSON.stringify({
              id: body.id,
              jsonrpc: '2.0',
              result: {
                capabilities: {},
                protocolVersion: '2025-11-25',
                serverInfo: { name: 'roots-recovery-server', version: '1' },
              },
            }),
            { headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId } }
          );
        }
        if (body.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (body.method === 'notifications/roots/list_changed') {
          rootsAttempts += 1;
          if (rootsAttempts === 1) {
            generation += 1;
            return new Response('expired', { status: 404 });
          }
          inFlightAbort.abort(new Error('aborted after send started'));
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected method: ${String(body.method)}`);
      },
      name: 'roots-recovery-canary',
      transport: 'streamable-http',
      url: 'https://roots-recovery.invalid/mcp',
    });

    await client.connect();
    await expect(client.sendRootsListChanged({ signal: inFlightAbort.signal })).resolves.toBe(
      undefined
    );
    expect(rootsAttempts).toBe(2);

    const preAborted = new AbortController();
    preAborted.abort(new Error('aborted before send'));
    await expect(client.sendRootsListChanged({ signal: preAborted.signal })).rejects.toThrow(
      'aborted before send'
    );
    expect(rootsAttempts).toBe(2);
  });

  it('emits canonical modern routing and x-mcp-header values from the tool definition', async () => {
    const requests: RecordedRequest[] = [];
    const client = trackClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request
          .clone()
          .json()
          .catch(() => undefined)) as { id?: number; method?: string } | undefined;
        requests.push({
          body,
          headers: Object.fromEntries(request.headers),
          method: request.method,
          pathname: request.url,
        });
        if (body?.method === 'server/discover') {
          return modernResponse(body.id, {
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: 'header-server', version: '1' },
            },
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        if (body?.method === 'tools/list') {
          return modernResponse(body.id, {
            cacheScope: 'private',
            resultType: 'complete',
            tools: [
              {
                inputSchema: {
                  properties: { account: { type: 'string', 'x-mcp-header': 'X-Account' } },
                  type: 'object',
                },
                name: 'lookup',
              },
            ],
            ttlMs: 0,
          });
        }
        return modernResponse(body?.id, {
          content: [{ text: 'ok', type: 'text' }],
          resultType: 'complete',
        });
      },
      name: 'canonical-header-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://headers.invalid/mcp',
    });

    await client.connect();
    await client.listTools();
    await client.callTool({ arguments: { account: 'acct-7' }, name: 'lookup' });

    const call = requests.find((request) => requestMethod(request.body) === 'tools/call');
    expect(call?.headers['mcp-method']).toBe('tools/call');
    expect(call?.headers['mcp-name']).toBe('lookup');
    expect(call?.headers['mcp-param-x-account']).toBe('acct-7');
    expect(call?.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(call?.body).toMatchObject({ method: 'tools/call', params: { name: 'lookup' } });
  });

  it.each([
    { header: 'mcp-method', value: 'tools/list' },
    { header: 'mcp-name', value: 'different-tool' },
    { header: 'mcp-param-x-account', value: 'different-account' },
  ])('official handler rejects a real $header/body mismatch', async ({ header, value }) => {
    const handler = createMcpHandler(() => createHeaderValidatingServer(), { legacy: 'reject' });
    cleanupTasks.push(() => handler.close());
    const mismatchedRequests: Array<{ body: unknown; header: string | null }> = [];
    const client = trackClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request
          .clone()
          .json()
          .catch(() => undefined)) as { id?: number; method?: string } | undefined;
        if (body?.method === 'server/discover') {
          return modernResponse(body.id, {
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        const mismatchedHeaders = new Headers(request.headers);
        mismatchedHeaders.set(header, value);
        const mismatchedRequest = new Request(request, { headers: mismatchedHeaders });
        mismatchedRequests.push({
          body: await mismatchedRequest.clone().json(),
          header: mismatchedRequest.headers.get(header),
        });
        return handler.fetch(mismatchedRequest);
      },
      name: 'header-mismatch-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://header-mismatch.invalid/mcp',
    });

    await client.connect();
    await client.listTools();
    await expect(
      client.callTool({ arguments: { account: 'acct-7' }, name: 'lookup' })
    ).rejects.toMatchObject({ code: -32_020 });
    expect(mismatchedRequests.at(-1)).toEqual({
      body: expect.objectContaining({
        method: 'tools/call',
        params: expect.objectContaining({
          arguments: { account: 'acct-7' },
          name: 'lookup',
        }),
      }),
      header: value,
    });
  });

  it('returns input_required at the explicit client boundary when requested manually', async () => {
    const client = trackClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request
          .clone()
          .json()
          .catch(() => undefined)) as { id?: number; method?: string } | undefined;
        if (body?.method === 'server/discover') {
          return modernResponse(body.id, {
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        return modernResponse(body?.id, {
          inputRequests: {
            confirmation: {
              message: 'Continue?',
              schema: { type: 'boolean' },
              type: 'elicitation',
            },
          },
          requestState: 'opaque-state',
          resultType: 'input_required',
        });
      },
      name: 'input-required-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://input-required.invalid/mcp',
    });

    await client.connect();
    await expect(
      client.callTool({ name: 'needs-confirmation' }, { allowInputRequired: true })
    ).resolves.toEqual({
      inputRequests: {
        confirmation: {
          message: 'Continue?',
          schema: { type: 'boolean' },
          type: 'elicitation',
        },
      },
      requestState: 'opaque-state',
      resultType: 'input_required',
    });
  });

  it('automatically fulfils modern elicitation with byte-exact request state', async () => {
    const calls: unknown[] = [];
    const client = trackClient({
      clientCapabilities: {
        elicitation: {
          form: true,
          handle: async (request) => {
            expect(request.params.message).toBe('Choose a city');
            return { action: 'accept', content: { city: 'Lisbon' } };
          },
          url: false,
        },
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.clone().json()) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (body.method === 'server/discover') {
          return modernResponse(body.id, {
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        calls.push(body.params);
        if (calls.length === 1) {
          return modernResponse(body.id, {
            inputRequests: {
              city: {
                method: 'elicitation/create',
                params: {
                  message: 'Choose a city',
                  mode: 'form',
                  requestedSchema: {
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                    type: 'object',
                  },
                },
              },
            },
            requestState: 'opaque-state-\u0000-byte',
            resultType: 'input_required',
          });
        }
        expect(body.params).toMatchObject({
          inputResponses: {
            city: { action: 'accept', content: { city: 'Lisbon' } },
          },
          requestState: 'opaque-state-\u0000-byte',
        });
        return modernResponse(body.id, {
          content: [{ text: 'Booked for Lisbon', type: 'text' }],
          resultType: 'complete',
        });
      },
      name: 'automatic-input-required-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://input-required.invalid/mcp',
    });

    await expect(client.callTool({ name: 'book' })).resolves.toMatchObject({
      content: [{ text: 'Booked for Lisbon', type: 'text' }],
    });
    expect(calls).toHaveLength(2);
  });

  it('fails closed on invalid accepted content without retrying the tool', async () => {
    let toolCalls = 0;
    const client = trackClient({
      clientCapabilities: {
        elicitation: {
          form: true,
          handle: async () => ({ action: 'accept', content: { city: 42 } }),
          url: false,
        },
      },
      fetch: async (input, init) => {
        const body = (await new Request(input, init).json()) as { id?: number; method?: string };
        if (body.method === 'server/discover') {
          return modernResponse(body.id, {
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        toolCalls += 1;
        return modernResponse(body.id, {
          inputRequests: {
            city: {
              method: 'elicitation/create',
              params: {
                message: 'Choose a city',
                requestedSchema: {
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                  type: 'object',
                },
              },
            },
          },
          requestState: 'state',
          resultType: 'input_required',
        });
      },
      name: 'invalid-elicitation-content-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://input-required.invalid/mcp',
    });

    await expect(client.callTool({ name: 'book' })).rejects.toThrow();
    expect(toolCalls).toBe(1);
  });

  it('surfaces finite input-required round exhaustion', async () => {
    let toolCalls = 0;
    const client = trackClient({
      clientCapabilities: {
        elicitation: {
          form: true,
          handle: async () => ({ action: 'decline' }),
          url: false,
        },
        maxInputRequiredRounds: 2,
      },
      fetch: async (input, init) => {
        const body = (await new Request(input, init).json()) as { id?: number; method?: string };
        if (body.method === 'server/discover') {
          return modernResponse(body.id, {
            capabilities: { tools: {} },
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
          });
        }
        toolCalls += 1;
        return modernResponse(body.id, {
          inputRequests: {
            confirmation: {
              method: 'elicitation/create',
              params: {
                message: 'Continue?',
                requestedSchema: { properties: {}, type: 'object' },
              },
            },
          },
          requestState: `state-${toolCalls}`,
          resultType: 'input_required',
        });
      },
      name: 'round-exhaustion-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://input-required.invalid/mcp',
    });

    await expect(client.callTool({ name: 'loop' })).rejects.toMatchObject({
      code: 'INPUT_REQUIRED_ROUNDS_EXCEEDED',
    });
    expect(toolCalls).toBe(3);
  });

  it('types manual input_required as a public result union without widening normal calls', () => {
    expectTypeOf(assertInputRequiredCallToolTypes).toBeFunction();
  });

  it('aborts an in-flight modern HTTP request at the server without replaying or sending cancellation JSON-RPC', async () => {
    const requests: RecordedRequest[] = [];
    const requestReceived = Promise.withResolvers<void>();
    const responseClosed = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
      const body = (await readJsonBody(request)) as { id?: number; method?: string };
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? 'UNKNOWN',
        pathname: request.url ?? '/',
      });
      if (body.method === 'server/discover') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            result: {
              capabilities: { tools: {} },
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
            },
          })
        );
        return;
      }
      requestReceived.resolve();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': waiting for cancellation\n\n');
      response.once('close', () => responseClosed.resolve());
      await new Promise<void>(() => undefined);
    });
    const url = await listen(server, '/mcp');
    const client = trackClient({
      name: 'modern-cancellation-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url,
    });

    await client.connect();
    const controller = new AbortController();
    const call = client.callTool({ name: 'slow-mutating-tool' }, { signal: controller.signal });
    await requestReceived.promise;
    controller.abort(new Error('caller cancelled'));
    await expect(call).rejects.toThrow(/cancelled/u);
    await Promise.race([
      responseClosed.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server did not observe abort')), 1000)
      ),
    ]);
    expect(requests.filter((request) => requestMethod(request.body) === 'tools/call')).toHaveLength(
      1
    );
    expect(
      requests.some((request) => requestMethod(request.body) === 'notifications/cancelled')
    ).toBe(false);
  });
});
