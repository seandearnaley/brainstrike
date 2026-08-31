import { InMemoryResponseCacheStore } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS,
  MAX_MCP_MAX_TOTAL_TIMEOUT_MS,
  normalizeMcpRequestOptions,
} from '../mcp/client-policy';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';

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

  it('rejects Streamable-HTTP-only scope step-up options on SSE', () => {
    expect(
      () =>
        new ExplicitHttpMcpClient({
          name: 'sse-step-up-canary',
          onInsufficientScope: 'reauthorize',
          transport: 'sse',
          url: 'https://example.test/sse',
        })
    ).toThrow('scope step-up options require Streamable HTTP');
  });
});
