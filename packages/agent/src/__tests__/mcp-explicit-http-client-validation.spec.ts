import { InMemoryResponseCacheStore } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';

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
});
