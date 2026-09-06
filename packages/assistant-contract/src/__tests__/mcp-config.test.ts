import { describe, expect, it } from 'vitest';
import { McpConfigValidationError, parseMcpConfigValue } from '../mcp-config.js';

describe('MCP config contract', () => {
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
