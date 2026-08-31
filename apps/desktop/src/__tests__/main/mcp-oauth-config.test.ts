import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../../mcp-loader';

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
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              auth,
              name: 'authenticated',
              transport: 'streamable-http',
              url: 'https://example.test/authenticated',
            },
          ],
        })
      )
    ).toThrow('MCP authentication requires the BST-1469 production host composition');
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
