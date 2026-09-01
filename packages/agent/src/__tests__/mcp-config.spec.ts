import { describe, expect, it } from 'vitest';
import {
  type McpConfig,
  McpConfigSchema,
  parseMcpConfig,
  parseMcpConfigWithMigrations,
  toMcpVersionNegotiation,
} from '../mcp/config';

describe('MCP config parser', () => {
  it('parses valid stdio, Streamable HTTP, and legacy SSE servers explicitly', () => {
    const text = JSON.stringify({
      servers: [
        {
          args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Documents'],
          command: 'npx',
          env: { NODE_ENV: 'test' },
          name: 'filesystem',
          transport: 'stdio',
        },
        {
          headers: {
            Authorization: 'Bearer streamable',
          },
          name: 'primary-remote',
          transport: 'streamable-http',
          url: 'http://localhost:7801/mcp',
        },
        {
          headers: {
            Authorization: 'Bearer foo',
          },
          name: 'legacy-remote',
          transport: 'sse',
          url: 'http://localhost:7801/sse',
        },
      ],
    });
    const cfg: McpConfig = parseMcpConfig(text);
    expect(cfg.servers.length).toBe(3);
    const s0 = cfg.servers[0];
    const s1 = cfg.servers[1];
    const s2 = cfg.servers[2];
    expect(s0?.transport).toBe('stdio');
    expect(s1?.transport).toBe('streamable-http');
    expect(s2?.transport).toBe('sse');
  });

  it('does not infer an HTTP transport from the URL path', () => {
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            name: 'streamable-at-sse-path',
            transport: 'streamable-http',
            url: 'https://example.com/sse',
          },
          {
            name: 'legacy-sse-at-mcp-path',
            transport: 'sse',
            url: 'https://example.com/mcp',
          },
        ],
      })
    );

    expect(cfg.servers.map((server) => server.transport)).toEqual(['streamable-http', 'sse']);
  });

  it('defaults omitted protocol policy visibly and preserves the effective policy on reload', () => {
    const raw = JSON.stringify({
      servers: [{ command: 'node', name: 'legacy-by-migration', transport: 'stdio' }],
    });

    const first = parseMcpConfigWithMigrations(raw);
    expect(first.config.servers[0]?.protocol).toBe('legacy');
    expect(first.migrations).toEqual([
      {
        code: 'mcp_protocol_defaulted_to_legacy',
        serverIndex: 0,
        serverName: 'legacy-by-migration',
      },
    ]);

    const reloaded = parseMcpConfigWithMigrations(JSON.stringify(first.config));
    expect(reloaded.config).toEqual(first.config);
    expect(reloaded.migrations).toEqual([]);
  });

  it('accepts every explicit protocol mode and rejects incompatible or unknown modes', () => {
    const parseServers = (servers: unknown[]) => parseMcpConfig(JSON.stringify({ servers }));
    const config = parseServers([
      { command: 'node', name: 'legacy', protocol: 'legacy', transport: 'stdio' },
      { command: 'node', name: 'auto', protocol: 'auto', transport: 'stdio' },
      {
        name: 'modern',
        protocol: '2026-07-28',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
      },
    ]);
    expect(config.servers.map(({ protocol }) => protocol)).toEqual([
      'legacy',
      'auto',
      '2026-07-28',
    ]);
    expect(toMcpVersionNegotiation('legacy')).toEqual({ mode: 'legacy' });
    expect(toMcpVersionNegotiation('auto')).toEqual({ mode: 'auto' });
    expect(toMcpVersionNegotiation('2026-07-28')).toEqual({ mode: { pin: '2026-07-28' } });

    expect(() =>
      parseServers([
        { name: 'invalid-sse', protocol: 'auto', transport: 'sse', url: 'https://example.com/sse' },
      ])
    ).toThrow(/legacy SSE transport requires protocol/u);
    expect(() =>
      parseServers([{ command: 'node', name: 'future', protocol: 'future', transport: 'stdio' }])
    ).toThrow(/invalid_mcp_config/u);
  });

  it('recognizes versioned and platform-shim mcp-remote forms without overriding explicit startup', () => {
    const detected = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            args: ['-y', 'mcp-remote@latest', 'https://mcp.example.test/mcp'],
            command: 'npx',
            name: 'versioned',
            transport: 'stdio',
          },
          {
            command: 'C:\\bin\\mcp-remote.cmd',
            name: 'shim',
            transport: 'stdio',
          },
          {
            args: ['-y', 'mcp-remote@0.1.29', 'https://mcp.example.test/mcp'],
            command: 'npx',
            name: 'explicit',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      })
    );
    expect(detected.servers.map(({ startup }) => startup)).toEqual([
      'authentication-required',
      'authentication-required',
      'automatic',
    ]);
  });

  it('rejects user-paced stdio authorization with auto negotiation at config load', () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              args: ['-y', 'mcp-remote@latest', 'https://mcp.example.test/mcp'],
              command: 'npx',
              name: 'unreachable',
              protocol: 'auto',
              transport: 'stdio',
            },
          ],
        })
      )
    ).toThrow('user-paced stdio authorization requires protocol');
  });

  it('rejects duplicate server names across different transports at the duplicate path', () => {
    const config = {
      servers: [
        { command: 'node', name: 'duplicate', transport: 'stdio' },
        {
          name: 'duplicate',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
        },
      ],
    };

    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected duplicate MCP server names to be rejected');
    }
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: 'duplicate server name',
        path: ['servers', 1, 'name'],
      })
    );
    expect(() => parseMcpConfig(JSON.stringify(config))).toThrow(
      JSON.stringify({
        code: 'invalid_mcp_config',
        issues: [{ message: 'duplicate server name', path: 'servers.1.name' }],
      })
    );
  });

  it('accepts the explicit empty authority and rejects unknown config fields', () => {
    expect(parseMcpConfig(JSON.stringify({ servers: [] }))).toEqual({ servers: [] });
    expect(() => parseMcpConfig(JSON.stringify({ ignored: true, servers: [] }))).toThrow(
      'invalid_mcp_config'
    );
  });

  it('reports malformed JSON without echoing configuration contents', () => {
    const secret = 'secret-looking-value';
    let error: unknown;
    try {
      parseMcpConfig(`{"servers":["${secret}"`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 'invalid_mcp_config',
      issues: [{ message: 'invalid JSON syntax', path: '' }],
      message: JSON.stringify({
        code: 'invalid_mcp_config',
        issues: [{ message: 'invalid JSON syntax', path: '' }],
      }),
    });
    expect(String(error)).not.toContain(secret);
  });
});
