import { describe, expect, it } from 'vitest';
import { McpConfigSchema } from '../mcp/config';

describe('agent MCP authentication configuration', () => {
  it('accepts explicit unauthenticated HTTP configuration', () => {
    const parsed = McpConfigSchema.parse({
      servers: [
        {
          auth: { type: 'none' },
          name: 'none',
          transport: 'streamable-http',
          url: 'https://example.test/none',
        },
      ],
    });

    expect(parsed.servers.map((server) => server.auth?.type)).toEqual(['none']);
  });

  it.each([
    ['oauth-user', { scopes: ['read'], type: 'oauth-user' }],
    [
      'bearer',
      {
        credential: {
          id: '00000000-0000-4000-8000-000000000001',
          store: 'mcp-credentials',
        },
        type: 'bearer',
      },
    ],
  ])('keeps %s gated until the production composition owns credentials', (_label, auth) => {
    expect(() =>
      McpConfigSchema.parse({
        servers: [
          {
            auth,
            name: 'authenticated',
            transport: 'streamable-http',
            url: 'https://example.test/authenticated',
          },
        ],
      })
    ).toThrow('MCP authentication requires the BST-1469 production host composition');
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
