import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../../mcp-loader';

describe('MCP explicit HTTP authentication modes', () => {
  it('accepts none, external bearer references, and OAuth user auth without secrets', () => {
    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            auth: { type: 'none' },
            name: 'public',
            transport: 'streamable-http',
            url: 'https://example.test/public',
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
      })
    );

    expect(config.servers.map((server) => ('auth' in server ? server.auth?.type : 'none'))).toEqual(
      ['none', 'bearer', 'oauth-user']
    );
    expect(JSON.stringify(config)).not.toContain('secret');
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
