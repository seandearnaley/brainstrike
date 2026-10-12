import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../src/mcp/config-file.js';

describe('MCP explicit HTTP authentication modes', () => {
  it('accepts explicit unauthenticated HTTP without secrets', () => {
    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            auth: { type: 'none' },
            name: 'public',
            transport: 'streamable-http',
            url: 'https://example.test/public',
          },
        ],
      })
    );

    expect(config.servers.map((server) => ('auth' in server ? server.auth?.type : 'none'))).toEqual(
      ['none']
    );
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('accepts OAuth only with explicit user-paced startup', () => {
    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            auth: { scopes: ['read'], type: 'oauth-user' },
            name: 'oauth',
            transport: 'streamable-http',
            url: 'https://example.test/oauth',
          },
        ],
      })
    );
    expect(config.servers[0]).toMatchObject({
      auth: { scopes: ['read'], type: 'oauth-user' },
      startup: 'authentication-required',
    });
  });

  it('accepts only an opaque secure-store reference for external bearer authentication', () => {
    const config = parseMcpConfig(
      JSON.stringify({
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
    );

    expect(config.servers[0]).toMatchObject({
      auth: {
        credential: {
          id: '00000000-0000-4000-8000-000000000001',
          store: 'mcp-credentials',
        },
        type: 'bearer',
      },
    });
    expect(JSON.stringify(config)).not.toContain('token');
  });

  it('rejects malformed or duplicate OAuth scope policy', () => {
    for (const scopes of [[], [''], ['read', 'read']]) {
      expect(() =>
        parseMcpConfig(
          JSON.stringify({
            servers: [
              {
                auth: { scopes, type: 'oauth-user' },
                name: 'oauth',
                transport: 'streamable-http',
                url: 'https://example.test/oauth',
              },
            ],
          })
        )
      ).toThrow('invalid_mcp_config');
    }
  });

  it('rejects MCP HTTP OAuth beside a configured Authorization header', () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              auth: { type: 'oauth-user' },
              headers: { Authorization: 'Bearer configured-secret' },
              name: 'conflicting',
              transport: 'streamable-http',
              url: 'https://example.test/mcp',
            },
          ],
        })
      )
    ).toThrow('auth mode must not be combined with an Authorization header');
  });

  it('rejects an external bearer reference beside a configured Authorization header', () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              auth: {
                credential: {
                  id: '00000000-0000-4000-8000-000000000001',
                  store: 'mcp-credentials',
                },
                type: 'bearer',
              },
              headers: { Authorization: 'Bearer configured-secret' },
              name: 'conflicting-bearer',
              transport: 'streamable-http',
              url: 'https://example.test/mcp',
            },
          ],
        })
      )
    ).toThrow('auth mode must not be combined with an Authorization header');
  });

  it('does not admit HTTP OAuth auth modes on stdio', () => {
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              auth: { type: 'oauth-user' },
              command: 'node',
              name: 'stdio-oauth',
              transport: 'stdio',
            },
          ],
        })
      )
    ).toThrow('Unrecognized key: "auth"');
  });
});
