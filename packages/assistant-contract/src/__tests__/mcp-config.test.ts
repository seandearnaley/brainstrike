import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  McpConfigSchema,
  McpConfigValidationError,
  McpServerSchema,
  parseMcpConfigValue,
  parseMcpServerValue,
} from '../mcp-config.js';

describe('MCP config contract', () => {
  it.each([
    [' \thttps://exa\nmple.test/mcp\r ', 'https://example.test/mcp'],
    ['https://EXAMPLE.test/a', 'https://EXAMPLE.test/a'],
    ['\0https://example.test/mcp\0', '\0https://example.test/mcp\0'],
  ])('preserves URL normalization for %j', (url, expected) => {
    expect(
      parseMcpServerValue({ name: 'remote', transport: 'streamable-http', url })
    ).toMatchObject({
      protocol: 'legacy',
      startup: 'automatic',
      url: expected,
    });
  });

  it.each(['mailto:user@example.test', 'file:///tmp/example', 'ftp://example.test/mcp'])(
    'rejects non-HTTP remote URLs before transport construction: %s',
    (url) => {
      for (const transport of ['streamable-http', 'sse']) {
        expect(() => parseMcpServerValue({ name: 'remote', transport, url })).toThrow(
          McpConfigValidationError
        );
      }
    }
  );

  it.each(['stdio', 'sse'] as const)(
    'rejects oauth-user on %s at every config entrypoint',
    (transport) => {
      const server = {
        auth: { type: 'oauth-user' },
        name: 'unsupported-oauth',
        transport,
        ...(transport === 'stdio' ? { command: 'node' } : { url: 'https://example.test/sse' }),
      };
      expect(
        Schema.decodeUnknownResult(McpServerSchema, { errors: 'all', onExcessProperty: 'error' })(
          server
        )._tag === 'Success'
      ).toBe(false);
      expect(
        Schema.decodeUnknownResult(McpConfigSchema, { errors: 'all', onExcessProperty: 'error' })({
          servers: [server],
        })._tag === 'Success'
      ).toBe(false);
      expect(() => parseMcpServerValue(server)).toThrow(McpConfigValidationError);
      expect(() => parseMcpConfigValue({ servers: [server] })).toThrow(McpConfigValidationError);
      if (transport === 'sse') {
        expect(() => parseMcpConfigValue({ servers: [server] })).toThrow(
          JSON.stringify({
            code: 'invalid_mcp_config',
            issues: [
              {
                message:
                  'auth "oauth-user" is not supported with transport "sse"; use "streamable-http"',
                path: 'servers.0.auth',
              },
            ],
          })
        );
      }
    }
  );
  it.each(['legacy', 'auto', '2026-07-28'] as const)(
    'keeps oauth-user supported on streamable-http with %s protocol',
    (protocol) => {
      expect(
        parseMcpServerValue({
          auth: { scopes: ['read'], type: 'oauth-user' },
          name: 'remote-oauth',
          protocol,
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
        })
      ).toMatchObject({
        auth: { scopes: ['read'], type: 'oauth-user' },
        protocol,
        startup: 'authentication-required',
      });
    }
  );
  it.each([
    undefined,
    { type: 'none' },
    {
      credential: { id: '00000000-0000-4000-8000-000000000001', store: 'mcp-credentials' },
      type: 'bearer',
    },
  ])('preserves supported SSE authentication: %j', (auth) => {
    expect(
      parseMcpServerValue({
        ...(auth === undefined ? {} : { auth }),
        name: 'legacy',
        transport: 'sse',
        url: 'https://example.test/sse',
      })
    ).toMatchObject({ protocol: 'legacy', startup: 'automatic', transport: 'sse' });
  });
  it('normalizes every supported transport through one strict validator', () => {
    const parsed = parseMcpConfigValue({
      servers: [
        {
          args: ['server.js'],
          command: 'node',
          name: 'local',
          transport: 'stdio',
        },
        {
          auth: { type: 'oauth-user' },
          name: 'remote',
          protocol: 'auto',
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
        },
        {
          name: 'legacy',
          transport: 'sse',
          url: 'https://example.test/sse',
        },
      ],
    });
    expect(parsed.config.servers.map(({ protocol, startup }) => ({ protocol, startup }))).toEqual([
      { protocol: 'legacy', startup: 'automatic' },
      { protocol: 'auto', startup: 'authentication-required' },
      { protocol: 'legacy', startup: 'automatic' },
    ]);
    expect(parsed.migrations).toEqual([
      { code: 'mcp_protocol_defaulted_to_legacy', serverIndex: 0, serverName: 'local' },
      { code: 'mcp_protocol_defaulted_to_legacy', serverIndex: 2, serverName: 'legacy' },
    ]);
  });
  it('accepts the explicit empty authority without inventing a server', () => {
    expect(parseMcpConfigValue({ servers: [] })).toEqual({
      config: { servers: [] },
      migrations: [],
    });
  });
  it('accepts a canonical bearer reference for capability-owning consumers', () => {
    expect(
      parseMcpConfigValue({
        servers: [
          {
            auth: {
              credential: {
                id: '00000000-0000-4000-8000-000000000001',
                store: 'mcp-credentials',
              },
              type: 'bearer',
            },
            name: 'bearer',
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
          },
        ],
      }).config.servers[0]
    ).toMatchObject({
      auth: { type: 'bearer' },
      startup: 'automatic',
    });
  });
  it.each([
    [
      'multiple unknown root fields',
      { debug: true, fallback: true, servers: [] },
      [{ message: 'Unrecognized keys: "debug", "fallback"', path: '' }],
    ],
    [
      'unknown root field',
      { debug: true, servers: [] },
      [{ message: 'Unrecognized key: "debug"', path: '' }],
    ],
    [
      'unknown server field',
      { servers: [{ command: 'node', fallback: true, name: 'local', transport: 'stdio' }] },
      [{ message: 'Unrecognized key: "fallback"', path: 'servers.0' }],
    ],
    [
      'invalid spawn value',
      { servers: [{ command: 'node\0shell', name: 'local', transport: 'stdio' }] },
      [{ message: 'invalid spawn string', path: 'servers.0.command' }],
    ],
    [
      'embedded URL credentials',
      {
        servers: [
          {
            name: 'remote',
            transport: 'streamable-http',
            url: 'https://user:secret@example.test/mcp',
          },
        ],
      },
      [{ message: 'must not include credentials', path: 'servers.0.url' }],
    ],
    [
      'duplicate case-insensitive headers',
      {
        servers: [
          {
            headers: { Authorization: 'one', authorization: 'two' },
            name: 'remote',
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
          },
        ],
      },
      [{ message: 'duplicate HTTP header name', path: 'servers.0.headers.authorization' }],
    ],
  ])('rejects %s with exact canonical diagnostics', (_name, value, expectedIssues) => {
    expect(() => parseMcpConfigValue(value)).toThrow(McpConfigValidationError);
    try {
      parseMcpConfigValue(value);
      throw new Error('Expected MCP config validation to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_mcp_config', issues: expectedIssues });
      expect((error as Error).message).toBe(
        JSON.stringify({ code: 'invalid_mcp_config', issues: expectedIssues })
      );
    }
  });
});
