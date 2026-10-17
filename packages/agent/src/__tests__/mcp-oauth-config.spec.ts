import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { McpConfigSchema } from '../mcp/config';

describe('agent MCP authentication configuration', () => {
  it('accepts explicit unauthenticated HTTP configuration', () => {
    const parsed = Schema.decodeUnknownSync(McpConfigSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      servers: [
        {
          auth: { type: 'none' },
          name: 'none',
          transport: 'streamable-http',
          url: 'https://example.test/none',
        },
      ],
    });
    expect(
      parsed.servers.map((server) => (server.transport === 'stdio' ? undefined : server.auth?.type))
    ).toEqual(['none']);
  });
  it('accepts OAuth only with explicit user-paced startup', () => {
    const parsed = Schema.decodeUnknownSync(McpConfigSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      servers: [
        {
          auth: { scopes: ['read'], type: 'oauth-user' },
          name: 'oauth',
          transport: 'streamable-http',
          url: 'https://example.test/oauth',
        },
      ],
    });
    expect(parsed.servers[0]).toMatchObject({
      auth: { scopes: ['read'], type: 'oauth-user' },
      startup: 'authentication-required',
    });
  });
  it('keeps bearer references gated until a credential resolver exists', () => {
    expect(() =>
      Schema.decodeUnknownSync(McpConfigSchema, { errors: 'all', onExcessProperty: 'error' })({
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
            url: 'https://example.test/bearer',
          },
        ],
      })
    ).toThrow('MCP bearer authentication requires a production credential resolver');
  });
  it('rejects selecting HTTP OAuth for stdio', () => {
    expect(() =>
      Schema.decodeUnknownSync(McpConfigSchema, { errors: 'all', onExcessProperty: 'error' })({
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
