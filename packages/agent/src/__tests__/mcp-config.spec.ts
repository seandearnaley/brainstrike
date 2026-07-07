import { describe, expect, it } from 'vitest';
import { type McpConfig, parseMcpConfig } from '../mcp/config';

describe('MCP config parser', () => {
  it('parses valid stdio and sse servers', () => {
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
            Authorization: 'Bearer foo',
          },
          name: 'web',
          transport: 'sse',
          url: 'http://localhost:7801/sse',
        },
      ],
    });
    const cfg: McpConfig = parseMcpConfig(text);
    expect(cfg.servers.length).toBe(2);
    const s0 = cfg.servers[0];
    const s1 = cfg.servers[1];
    expect(s0?.transport).toBe('stdio');
    expect(s1?.transport).toBe('sse');
  });

  it('throws on invalid config', () => {
    const bad = JSON.stringify({ servers: [] });
    expect(() => parseMcpConfig(bad)).toThrowError();
  });
});
