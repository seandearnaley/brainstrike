import { describe, expect, it } from 'vitest';
import { McpConfigSchema } from '../mcp/config';

describe('agent MCP authentication configuration', () => {
  it('accepts token-free explicit auth modes for HTTP servers', () => {
    const parsed = McpConfigSchema.parse({
      servers: [
        {
          auth: { type: 'none' },
          name: 'none',
          transport: 'streamable-http',
          url: 'https://example.test/none',
        },
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
          url: 'https://example.test/bearer',
        },
        {
          auth: { type: 'oauth-user' },
          name: 'oauth',
          transport: 'streamable-http',
          url: 'https://example.test/oauth',
        },
      ],
    });

    expect(parsed.servers.map((server) => server.auth?.type)).toEqual([
      'none',
      'bearer',
      'oauth-user',
    ]);
  });

  it('rejects selecting HTTP OAuth for stdio', () => {
    expect(() =>
      McpConfigSchema.parse({
        servers: [
          {
            auth: { type: 'oauth-user' },
            command: 'node',
            name: 'stdio-oauth',
            transport: 'stdio',
          },
        ],
      })
    ).toThrow();
  });
});
