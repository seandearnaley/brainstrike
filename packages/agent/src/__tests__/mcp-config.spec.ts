import { describe, expect, it } from 'vitest';
import { type McpConfig, McpConfigSchema, parseMcpConfig } from '../mcp/config';

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
      /"message":"duplicate server name","path":"servers\.1\.name"/u
    );
  });

  it('throws on invalid config', () => {
    const bad = JSON.stringify({ servers: [] });
    expect(() => parseMcpConfig(bad)).toThrowError();
  });
});
