import {
  type Client,
  InMemoryResponseCacheStore,
  SUBSCRIPTION_ID_META_KEY,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import {
  DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS,
  MAX_MCP_MAX_TOTAL_TIMEOUT_MS,
  normalizeMcpRequestOptions,
} from '../mcp/client-policy';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import type { RegisteredExtensionDispatchLedger } from '../mcp/registered-extension-dispatch';
import {
  MCP_TASKS_STATUS_NOTIFICATION_CONTRACT,
  registerMcpTasksWireContracts,
} from '../mcp/tasks-extension';

describe('ExplicitHttpMcpClient validation', () => {
  it.each(['file:///tmp/mcp.sock', 'ftp://example.test/mcp'])(
    'rejects the non-HTTP remote URL %s',
    (url) => {
      expect(
        () =>
          new ExplicitHttpMcpClient({
            name: 'invalid-url-canary',
            transport: 'streamable-http',
            url,
          })
      ).toThrow('MCP HTTP URL must use http: or https:');
    }
  );

  it('rejects embedded URL credentials before making a request', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          name: 'credential-url-canary',
          transport: 'sse',
          url: 'https://user:password@example.test/mcp',
        })
    ).toThrow('MCP HTTP URL must not include credentials');
  });

  it('rejects an unsupported lifecycle from an untyped consumer', () => {
    const options = {
      lifecycle: 'host-owner',
      name: 'invalid-lifecycle-canary',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    };
    expect(() => Reflect.construct(ExplicitHttpMcpClient, [options])).toThrow('host-owner');
  });

  it('rejects a non-callable unexpected-close observer from an untyped consumer', () => {
    const options = {
      name: 'invalid-observer-canary',
      onUnexpectedClose: 'not-callable',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    };

    expect(() => Reflect.construct(ExplicitHttpMcpClient, [options])).toThrow(
      'onUnexpectedClose must be a function'
    );
  });

  it('rejects a non-callable server-feature diagnostic sink from an untyped consumer', () => {
    const options = {
      name: 'invalid-feature-diagnostic-canary',
      onServerFeatureEventError: 'not-callable',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    };

    expect(() => Reflect.construct(ExplicitHttpMcpClient, [options])).toThrow(
      'onServerFeatureEventError must be a function'
    );
  });

  it.each(['auto', '2026-07-28'] as const)(
    'rejects protocol %s on legacy SSE at the public client boundary',
    (protocol) => {
      expect(
        () =>
          new ExplicitHttpMcpClient({
            name: 'sse-protocol-canary',
            protocol,
            transport: 'sse',
            url: 'https://example.test/sse',
          })
      ).toThrow(
        `MCP client "sse-protocol-canary": legacy SSE transport requires protocol "legacy" (got "${protocol}")`
      );
    }
  );

  it.each(['Accept', 'content-TYPE', 'MCP-Session-Id', 'mcp-PROTOCOL-version', 'Last-Event-ID'])(
    'rejects the protocol-owned configured header %s before requesting',
    (header) => {
      let fetchCalled = false;
      expect(
        () =>
          new ExplicitHttpMcpClient({
            fetch: async () => {
              fetchCalled = true;
              return new Response(null, { status: 500 });
            },
            headers: { [header]: 'caller-controlled-value' },
            name: 'protocol-header-canary',
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
          })
      ).toThrow(`Configured MCP header "${header}" is protocol-owned`);
      expect(fetchCalled).toBe(false);
    }
  );

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 1.5])(
    'rejects a non-finite automatic list page cap (%s)',
    (listMaxPages) => {
      expect(
        () =>
          new ExplicitHttpMcpClient({
            listMaxPages,
            name: 'invalid-list-cap-canary',
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
          })
      ).toThrow('MCP automatic list pagination cap must be a positive safe integer');
    }
  );

  it('rejects a shared response cache without an explicit principal partition', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          name: 'unpartitioned-cache-canary',
          responseCacheStore: new InMemoryResponseCacheStore(),
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
        })
    ).toThrow('MCP response cache partition is required when sharing a response cache store');
  });

  it('rejects an empty shared response-cache principal partition', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          cachePartition: '   ',
          name: 'empty-cache-partition-canary',
          responseCacheStore: new InMemoryResponseCacheStore(),
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
        })
    ).toThrow('MCP response cache partition must not be empty');
  });

  it('applies the same shared-cache partition guard to stdio', () => {
    expect(
      () =>
        new ExplicitStdioMcpClient({
          command: 'mcp-server',
          name: 'unpartitioned-stdio-cache-canary',
          responseCacheStore: new InMemoryResponseCacheStore(),
        })
    ).toThrow('MCP response cache partition is required when sharing a response cache store');
  });

  it('trims the shared-cache principal partition', () => {
    expect(
      () =>
        new ExplicitStdioMcpClient({
          cachePartition: ' principal-a ',
          command: 'mcp-server',
          name: 'partitioned-stdio-cache-canary',
          responseCacheStore: new InMemoryResponseCacheStore(),
        })
    ).not.toThrow();
  });

  it('defaults the absolute timeout while permitting a larger bounded policy', () => {
    expect(normalizeMcpRequestOptions(undefined).maxTotalTimeout).toBe(
      DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS
    );
    expect(
      normalizeMcpRequestOptions({ maxTotalTimeout: MAX_MCP_MAX_TOTAL_TIMEOUT_MS }).maxTotalTimeout
    ).toBe(MAX_MCP_MAX_TOTAL_TIMEOUT_MS);
    expect(() =>
      normalizeMcpRequestOptions({ maxTotalTimeout: MAX_MCP_MAX_TOTAL_TIMEOUT_MS + 1 })
    ).toThrow(`at most ${MAX_MCP_MAX_TOTAL_TIMEOUT_MS}`);
  });

  it('re-resolves catalog metadata for a recovered call instead of retaining the old generation', async () => {
    const client = new ExplicitHttpMcpClient({
      name: 'recovered-tool-definition-canary',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    const oldDefinition = {
      inputSchema: {
        properties: { account: { type: 'string', 'x-mcp-header': 'X-Account' } },
        type: 'object',
      },
      name: 'lookup',
    } as const;
    Reflect.set(client, 'toolDefinitions', new Map([['lookup', oldDefinition]]));
    const firstCall = vi.fn(async () => ({ content: [] }));
    const recoveredCall = vi.fn(async () => ({ content: [] }));
    Reflect.set(
      client,
      'runRequest',
      async (request: (sdkClient: { callTool: typeof firstCall }) => Promise<unknown>) => {
        await request({ callTool: firstCall });
        Reflect.set(client, 'toolDefinitions', new Map());
        return await request({ callTool: recoveredCall });
      }
    );

    await client.callTool({ arguments: { account: 'acct-old' }, name: 'lookup' });

    expect(firstCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toolDefinition: oldDefinition })
    );
    expect(recoveredCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ toolDefinition: expect.anything() })
    );
  });

  it('forces each first cursorless catalog request to refresh after every HTTP connection generation', async () => {
    const client = new ExplicitHttpMcpClient({
      name: 'http-catalog-refresh-canary',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    const observed: Array<{ cacheMode: unknown; method: string }> = [];
    const sdkClient = {
      listPrompts: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'prompts/list' });
        return { prompts: [] };
      }),
      listResources: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'resources/list' });
        return { resources: [] };
      }),
      listResourceTemplates: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'resources/templates/list' });
        return { resourceTemplates: [] };
      }),
      listTools: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'tools/list' });
        return { tools: [] };
      }),
    };
    let generation = 1;
    Reflect.set(
      client,
      'runRequest',
      async (
        request: (target: typeof sdkClient, connection: { generation: number }) => Promise<unknown>
      ) => await request(sdkClient, { generation })
    );

    const listEveryCatalog = async (): Promise<void> => {
      await client.listTools();
      await client.listResources();
      await client.listResourceTemplates();
      await client.listPrompts();
    };
    await listEveryCatalog();
    await listEveryCatalog();
    generation = 2;
    await listEveryCatalog();

    expect(observed).toEqual(
      [1, 2, 3].flatMap((round) =>
        ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].map(
          (method) => ({ cacheMode: round === 2 ? undefined : 'refresh', method })
        )
      )
    );
  });

  it('forces each first cursorless catalog request to refresh for every stdio connection', async () => {
    const client = new ExplicitStdioMcpClient({
      command: 'mcp-server',
      name: 'stdio-catalog-refresh-canary',
    });
    const observed: Array<{ cacheMode: unknown; method: string }> = [];
    const sdkClient = {
      listPrompts: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'prompts/list' });
        return { prompts: [] };
      }),
      listResources: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'resources/list' });
        return { resources: [] };
      }),
      listResourceTemplates: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'resources/templates/list' });
        return { resourceTemplates: [] };
      }),
      listTools: vi.fn(async (_params, options) => {
        observed.push({ cacheMode: options.cacheMode, method: 'tools/list' });
        return { tools: [] };
      }),
    };
    const createConnection = () => ({
      catalogRefreshes: new Set(),
      client: sdkClient,
      disconnected: false,
      removeStderrListener: vi.fn(),
      toolDefinitions: new Map(),
      toolMetadataReady: false,
      toolMetadataRequest: undefined,
      transport: { close: vi.fn() },
    });
    let connection = createConnection();
    Reflect.set(client, 'getConnection', async () => connection);

    const listEveryCatalog = async (): Promise<void> => {
      await client.listTools();
      await client.listResources();
      await client.listResourceTemplates();
      await client.listPrompts();
    };
    await listEveryCatalog();
    await listEveryCatalog();
    connection = createConnection();
    await listEveryCatalog();

    expect(observed).toEqual(
      [1, 2, 3].flatMap((round) =>
        ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].map(
          (method) => ({ cacheMode: round === 2 ? undefined : 'refresh', method })
        )
      )
    );
  });

  it('routes modern listen through the HTTP request recovery seam', async () => {
    const client = new ExplicitHttpMcpClient({
      name: 'listen-recovery-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    const listen = vi.fn(async () => ({ close: vi.fn(), id: 'subscription-1' }));
    const runRequest = vi.fn(
      async (request: (target: { listen: typeof listen }) => Promise<unknown>) =>
        await request({ listen })
    );
    Reflect.set(client, 'runRequest', runRequest);
    Reflect.set(client, 'getConnection', () => {
      throw new Error('listen bypassed runRequest');
    });

    await expect(client.listen({ toolsListChanged: true })).resolves.toMatchObject({
      id: 'subscription-1',
    });
    expect(runRequest).toHaveBeenCalledOnce();
  });

  it('routes Tasks notification leases through the Streamable HTTP recovery seam', async () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const client = new ExplicitHttpMcpClient({
      extensionRegistry: registry,
      name: 'tasks-listen-recovery-canary',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    const subscription = {
      close: vi.fn(async () => undefined),
      closed: Promise.resolve('local' as const),
      honoredFilter: {},
    };
    // Stands in for the transport dispatch bridge, which is the only place the
    // server's raw (unstripped) acknowledgement is observable (BST-1596).
    const dispatchLedger = Reflect.get(
      Reflect.get(client, 'options') as object,
      'extensionDispatchLedger'
    ) as RegisteredExtensionDispatchLedger;
    const dispatchScope = dispatchLedger.openTransportScope();
    const sdkClient = {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
      listen: vi.fn(async (filter: unknown) => {
        dispatchScope.bindSubscriptionRequest('listen:0', { notifications: filter });
        dispatchScope.recordSubscriptionAcknowledgement({
          _meta: { [SUBSCRIPTION_ID_META_KEY]: 'listen:0' },
          notifications: { taskIds: ['task-http-1'] },
        });
        return subscription;
      }),
      removeNotificationHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
    } as unknown as Client;
    const runRequest = vi.fn(
      async (request: (target: Client) => Promise<unknown>) => await request(sdkClient)
    );
    Reflect.set(client, 'runRequest', runRequest);

    const lease = await client.listenTasks(['task-http-1'], vi.fn());

    expect(runRequest).toHaveBeenCalledOnce();
    expect(lease.honoredTaskIds).toEqual(['task-http-1']);
    expect(sdkClient.setNotificationHandler).toHaveBeenCalledWith(
      MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.method,
      { params: MCP_TASKS_STATUS_NOTIFICATION_CONTRACT.paramsSchema },
      expect.any(Function)
    );
    expect(sdkClient.listen).toHaveBeenCalledWith({ taskIds: ['task-http-1'] }, expect.any(Object));
    await lease.close();
  });

  it('advances the observable generation as soon as an active connection is invalidated', () => {
    const client = new ExplicitHttpMcpClient({
      name: 'invalidation-generation-canary',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    const connection = { disconnected: false };
    Reflect.set(client, 'connectionGeneration', 7);
    Reflect.set(client, 'activeConnection', connection);
    const invalidate = Reflect.get(client, 'invalidateConnection') as (
      this: ExplicitHttpMcpClient,
      value: typeof connection
    ) => boolean;

    expect(invalidate.call(client, connection)).toBe(true);
    expect(client.getConnectionGeneration()).toBe(8);
    expect(invalidate.call(client, connection)).toBe(false);
    expect(client.getConnectionGeneration()).toBe(8);
  });

  it('rejects configured authorization headers beside a host-owned auth provider', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          authProvider: { token: async () => 'host-owned-token' },
          headers: { Authorization: 'Bearer configured-token' },
          name: 'conflicting-auth-canary',
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
        })
    ).toThrow('must not combine configured Authorization headers with authProvider');
  });

  it.each([-1, 4, 1.5, Number.POSITIVE_INFINITY])(
    'rejects the invalid OAuth scope step-up retry count %s',
    (maxStepUpRetries) => {
      expect(
        () =>
          new ExplicitHttpMcpClient({
            maxStepUpRetries,
            name: 'invalid-step-up-canary',
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
          })
      ).toThrow('MCP OAuth step-up retries must be a safe integer from 0 to 3');
    }
  );

  it.each([
    ['onInsufficientScope', { onInsufficientScope: 'reauthorize' } as const],
    ['maxStepUpRetries', { maxStepUpRetries: 2 } as const],
  ])('rejects the Streamable-HTTP-only scope step-up option %s on SSE', (_label, option) => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          ...option,
          name: 'sse-step-up-canary',
          transport: 'sse',
          url: 'https://example.test/sse',
        })
    ).toThrow('MCP OAuth scope step-up options require Streamable HTTP transport');
  });

  it('rejects an interactive OAuth callback source on SSE', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          authorizationCallbackSource: { takePendingAuthorizationCallback: () => undefined },
          authorizationCallbackTimeoutMs: 60_000,
          name: 'sse-interactive-oauth-canary',
          transport: 'sse',
          url: 'https://example.test/sse',
        })
    ).toThrow(
      'MCP client "sse-interactive-oauth-canary": interactive OAuth completion requires Streamable HTTP transport'
    );
  });

  // The timeout is read only while building the interactive completion, which a
  // missing callback source skips, so on its own it could never take effect on
  // any transport. Pinned on both so the guard cannot be narrowed to SSE.
  it.each([{ transport: 'sse' } as const, { transport: 'streamable-http' } as const])(
    'rejects an interactive OAuth callback timeout without a callback source on $transport',
    ({ transport }) => {
      expect(
        () =>
          new ExplicitHttpMcpClient({
            authorizationCallbackTimeoutMs: 60_000,
            name: 'orphan-callback-timeout-canary',
            protocol: transport === 'sse' ? 'legacy' : undefined,
            transport,
            url: 'https://example.test/mcp',
          })
      ).toThrow(
        'MCP client "orphan-callback-timeout-canary": authorizationCallbackTimeoutMs requires authorizationCallbackSource'
      );
    }
  );
});
