import { describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../src/mcp/config-file.js';

describe('MCP config parsing', () => {
  describe('parseMcpConfig', () => {
    it('should parse valid stdio server config', () => {
      const json = JSON.stringify({
        servers: [
          {
            args: ['server.js'],
            command: 'node',
            env: { NODE_ENV: 'test' },
            name: 'test-server',
            transport: 'stdio',
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toMatchObject({
        args: ['server.js'],
        command: 'node',
        env: { NODE_ENV: 'test' },
        name: 'test-server',
        transport: 'stdio',
      });
    });

    it('should parse valid sse server config', () => {
      const json = JSON.stringify({
        servers: [
          {
            headers: { Authorization: 'Bearer token' },
            name: 'sse-server',
            transport: 'sse',
            url: 'https://api.example.com/sse',
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toMatchObject({
        headers: { Authorization: 'Bearer token' },
        name: 'sse-server',
        transport: 'sse',
        url: 'https://api.example.com/sse',
      });
    });

    it('should parse Streamable HTTP explicitly without inferring from its URL path', () => {
      const json = JSON.stringify({
        servers: [
          {
            headers: { Authorization: 'Bearer token' },
            name: 'streamable-server',
            transport: 'streamable-http',
            url: 'https://api.example.com/sse',
          },
          {
            name: 'legacy-sse-server',
            transport: 'sse',
            url: 'https://api.example.com/mcp',
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers.map((server) => server.transport)).toEqual(['streamable-http', 'sse']);
      expect(result.servers[0]).toMatchObject({
        headers: { Authorization: 'Bearer token' },
        name: 'streamable-server',
        transport: 'streamable-http',
        url: 'https://api.example.com/sse',
      });
    });

    it('should parse multiple servers', () => {
      const json = JSON.stringify({
        servers: [
          { command: 'cmd1', name: 'server1', transport: 'stdio' },
          { name: 'server2', transport: 'sse', url: 'http://localhost' },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(2);
    });

    it('should reject duplicate server names at the duplicate entry path', () => {
      const json = JSON.stringify({
        servers: [
          { command: 'first', name: 'duplicate', transport: 'stdio' },
          { name: 'duplicate', transport: 'sse', url: 'https://example.com/sse' },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.1\.name: duplicate server name/u
      );
    });

    it('should reject the reserved __proto__ server name', () => {
      const json = JSON.stringify({
        servers: [
          {
            command: 'node',
            name: '__proto__',
            transport: 'stdio',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.name: reserved server name/u
      );
    });

    it('should reject duplicate properties in a server object with source context', () => {
      const json = `{
  "servers": [
    {
      "transport": "stdio",
      "name": "first",
      "name": "second",
      "command": "node"
    }
  ]
}`;

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config: duplicate property "name" at line 6, column 7 \(servers\.0\.name\)/u
      );
    });

    it.each([
      ['headers', 'sse', '"url": "https://example.com/mcp",'],
      ['env', 'stdio', '"command": "node",'],
    ] as const)(
      'should reject duplicate properties in a nested %s object with source context',
      (recordName, transport, requiredProperty) => {
        const json = `{
  "servers": [
    {
      "transport": "${transport}",
      "name": "duplicate-nested",
      ${requiredProperty}
      "${recordName}": {
        "TOKEN": "first",
        "TOKEN": "second"
      }
    }
  ]
}`;

        expect(() => parseMcpConfig(json)).toThrow(
          new RegExp(
            `invalid_mcp_config: duplicate property "TOKEN" at line 9, column 9 \\(servers\\.0\\.${recordName}\\.TOKEN\\)`,
            'u'
          )
        );
      }
    );

    it('should reject the whole config when any server is invalid and report its path', () => {
      const json = JSON.stringify({
        servers: [
          { command: 'cmd', name: 'valid', transport: 'stdio' },
          { name: 'invalid', transport: 'invalid' },
          { transport: 'stdio' }, // missing required fields
          { name: 'partial', transport: 'sse' }, // missing url
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.1\.transport.*servers\.2\.command.*servers\.3\.url/u
      );
    });

    it('should throw for invalid JSON', () => {
      expect(() => parseMcpConfig('invalid json')).toThrow('invalid_mcp_config:');
    });

    it('should throw when servers is not an array', () => {
      const json = JSON.stringify({ servers: 'not-an-array' });
      expect(() => parseMcpConfig(json)).toThrow(/invalid_mcp_config:.*servers:/u);
    });

    it('should allow an empty servers array for template-only configs', () => {
      const json = JSON.stringify({ servers: [] });
      const result = parseMcpConfig(json);
      expect(result.servers).toEqual([]);
    });

    it('should throw when all declared servers are invalid', () => {
      const json = JSON.stringify({
        servers: [{ transport: 'stdio' }, { name: 'missing-url', transport: 'sse' }],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.command.*servers\.0\.name.*servers\.1\.url/u
      );
    });

    it('should throw when servers field is missing', () => {
      const json = JSON.stringify({ other: 'field' });
      expect(() => parseMcpConfig(json)).toThrow(/invalid_mcp_config:.*servers:/u);
    });

    it('should handle stdio server without optional fields', () => {
      const json = JSON.stringify({
        servers: [{ command: 'cmd', name: 'minimal', transport: 'stdio' }],
      });

      const result = parseMcpConfig(json);
      expect(result.servers[0]).toEqual({
        command: 'cmd',
        name: 'minimal',
        protocol: 'legacy',
        startup: 'automatic',
        transport: 'stdio',
      });
    });

    it('should handle sse server without optional headers', () => {
      const json = JSON.stringify({
        servers: [{ name: 'minimal-sse', transport: 'sse', url: 'http://example.com' }],
      });

      const result = parseMcpConfig(json);
      expect(result.servers[0]).toEqual({
        name: 'minimal-sse',
        protocol: 'legacy',
        startup: 'automatic',
        transport: 'sse',
        url: 'http://example.com',
      });
    });

    it('should reject non-string stdio args with their array path', () => {
      const json = JSON.stringify({
        servers: [
          {
            args: ['valid', 123, null, 'another'],
            command: 'node',
            name: 'test',
            transport: 'stdio',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.args\.1.*servers\.0\.args\.2/u
      );
    });

    it.each([
      {
        expectedPath: 'servers.0.command',
        server: { command: 'node\0malformed' },
      },
      {
        expectedPath: 'servers.0.args.1',
        server: { args: ['valid', 'malformed\0argument'], command: 'node' },
      },
    ])('should reject NUL in stdio spawn input at $expectedPath', ({ expectedPath, server }) => {
      const json = JSON.stringify({
        servers: [
          {
            ...server,
            name: 'test',
            transport: 'stdio',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        new RegExp(
          `invalid_mcp_config:.*${expectedPath.replaceAll('.', '\\.')}: invalid spawn string`,
          'u'
        )
      );
    });

    it('should reject invalid environment and header values with their record paths', () => {
      const json = JSON.stringify({
        servers: [
          {
            command: 'node',
            env: { PORT: 3000 },
            name: 'local',
            transport: 'stdio',
          },
          {
            headers: { Authorization: ['Bearer token'] },
            name: 'remote',
            transport: 'sse',
            url: 'https://example.com/sse',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.env\.PORT.*servers\.1\.headers\.Authorization/u
      );
    });

    it('should reject stdio environment entries that Node cannot pass to spawn', () => {
      const emptyName = JSON.stringify({
        servers: [
          {
            command: 'node',
            env: { '': 'value' },
            name: 'local',
            transport: 'stdio',
          },
        ],
      });
      const invalidName = JSON.stringify({
        servers: [
          {
            command: 'node',
            env: { 'BAD=KEY': 'value' },
            name: 'local',
            transport: 'stdio',
          },
        ],
      });
      const nullName = JSON.stringify({
        servers: [
          {
            command: 'node',
            env: { 'BAD\0KEY': 'value' },
            name: 'local',
            transport: 'stdio',
          },
        ],
      });
      const nullValue = JSON.stringify({
        servers: [
          {
            command: 'node',
            env: { TOKEN: 'before\0after' },
            name: 'local',
            transport: 'stdio',
          },
        ],
      });

      expect(() => parseMcpConfig(emptyName)).toThrow(
        /invalid_mcp_config:.*servers\.0\.env\.: invalid environment variable name/u
      );
      expect(() => parseMcpConfig(invalidName)).toThrow(
        /invalid_mcp_config:.*servers\.0\.env\.BAD=KEY: invalid environment variable name/u
      );
      expect(() => parseMcpConfig(nullName)).toThrow(/invalid environment variable name/u);
      expect(() => parseMcpConfig(nullValue)).toThrow(
        /invalid_mcp_config:.*servers\.0\.env\.TOKEN: invalid environment variable value/u
      );
    });

    it('should reject header names that the WHATWG Headers runtime rejects', () => {
      const json = JSON.stringify({
        servers: [
          {
            headers: { 'Invalid Header': 'value' },
            name: 'remote',
            transport: 'sse',
            url: 'https://example.com/mcp',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.headers\.Invalid Header: invalid HTTP header name/u
      );
    });

    it('should reject case-insensitive duplicate HTTP header names', () => {
      const json = JSON.stringify({
        servers: [
          {
            headers: { Authorization: 'first', authorization: 'second' },
            name: 'remote',
            transport: 'sse',
            url: 'https://example.com/mcp',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.headers\.authorization: duplicate HTTP header name/u
      );
    });

    it('should reject carriage-return and line-feed header values at their record paths', () => {
      const json = JSON.stringify({
        servers: [
          {
            headers: {
              'X-Carriage-Return': 'first\rsecond',
              'X-Line-Feed': 'first\nsecond',
            },
            name: 'remote',
            transport: 'sse',
            url: 'http://localhost:3000/mcp',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(
        /invalid_mcp_config:.*servers\.0\.headers\.X-Carriage-Return: invalid HTTP header value.*servers\.0\.headers\.X-Line-Feed: invalid HTTP header value/u
      );
    });

    it('should reject invalid and non-HTTP remote URLs with their server paths', () => {
      const invalidUrl = JSON.stringify({
        servers: [{ name: 'invalid', transport: 'sse', url: 'not a url' }],
      });
      const unsupportedProtocol = JSON.stringify({
        servers: [{ name: 'file', transport: 'sse', url: 'file:///tmp/mcp.sock' }],
      });

      expect(() => parseMcpConfig(invalidUrl)).toThrow(/invalid_mcp_config:.*servers\.0\.url/u);
      expect(() => parseMcpConfig(unsupportedProtocol)).toThrow(
        /invalid_mcp_config:.*servers\.0\.url/u
      );
    });

    it.each(['sse', 'streamable-http'] as const)(
      'should apply the same URL and header validation to %s',
      (transport) => {
        const invalidUrl = JSON.stringify({
          servers: [{ name: 'invalid-url', transport, url: 'file:///tmp/mcp.sock' }],
        });
        const invalidHeader = JSON.stringify({
          servers: [
            {
              headers: { 'Invalid Header': 'value' },
              name: 'invalid-header',
              transport,
              url: 'https://example.com/mcp',
            },
          ],
        });

        expect(() => parseMcpConfig(invalidUrl)).toThrow(/invalid_mcp_config:.*servers\.0\.url/u);
        expect(() => parseMcpConfig(invalidHeader)).toThrow(
          /invalid_mcp_config:.*servers\.0\.headers\.Invalid Header: invalid HTTP header name/u
        );
      }
    );

    it.each(['https://user@example.com/mcp', 'https://user:password@example.com/mcp'])(
      'should reject credentials in a remote URL: %s',
      (url) => {
        const json = JSON.stringify({
          servers: [{ name: 'remote', transport: 'sse', url }],
        });

        expect(() => parseMcpConfig(json)).toThrow(
          /invalid_mcp_config:.*servers\.0\.url: must not include credentials/u
        );
      }
    );

    it('should reject unknown server keys instead of silently dropping misspelled settings', () => {
      const json = JSON.stringify({
        servers: [
          {
            comand: 'node',
            command: 'node',
            name: 'local',
            transport: 'stdio',
          },
        ],
      });

      expect(() => parseMcpConfig(json)).toThrow(/invalid_mcp_config:.*servers\.0:.*comand/u);
    });

    it.each([
      {
        json: '{"__proto__":{"polluted":true},"servers":[]}',
        path: '__proto__',
      },
      {
        json: `{"servers":[{"__proto__":{"polluted":true},"command":"node","name":"local","transport":"stdio"}]}`,
        path: 'servers.0.__proto__',
      },
      {
        json: `{"servers":[{"command":"node","env":{"__proto__":"secret"},"name":"local","transport":"stdio"}]}`,
        path: 'servers.0.env.__proto__',
      },
      {
        json: `{"servers":[{"headers":{"__proto__":"secret"},"name":"remote","transport":"sse","url":"https://example.com/mcp"}]}`,
        path: 'servers.0.headers.__proto__',
      },
    ])('should reject a __proto__ property at $path', ({ json, path }) => {
      expect(() => parseMcpConfig(json)).toThrow(
        new RegExp(`invalid_mcp_config:.*forbidden property "__proto__".*\\(${path}\\)`, 'u')
      );
    });

    it('should parse JSON with comments', () => {
      const jsonWithComments = `{
        // comment
        "servers": [
          {
            "transport": "sse",
            "name": "commented",
            "url": "http://localhost:3000/sse"
          }
        ]
      }`;

      const result = parseMcpConfig(jsonWithComments);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]?.name).toBe('commented');
    });

    it('should parse JSONC with trailing commas', () => {
      const jsonWithTrailingCommas = `{
        "servers": [
          {
            "transport": "stdio",
            "name": "filesystem",
            "command": "npx",
            "args": [
              "-y",
              "@modelcontextprotocol/server-filesystem",
            ],
          },
        ],
      }`;

      const result = parseMcpConfig(jsonWithTrailingCommas);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]?.name).toBe('filesystem');
    });

    it('should keep comment tokens inside JSON strings', () => {
      const jsonWithCommentTokensInString = `{
        "servers": [
          {
            "transport": "sse",
            "name": "string-tokens",
            "url": "https://example.com/sse",
            "headers": {
              "X-Notes": "keep // text and /* markers */ in string"
            }
          }
        ]
      }`;

      const result = parseMcpConfig(jsonWithCommentTokensInString);
      expect(result.servers).toHaveLength(1);
      const server = result.servers[0];
      if (server?.transport !== 'sse') {
        throw new Error('expected sse server');
      }
      expect(server.headers?.['X-Notes']).toBe('keep // text and /* markers */ in string');
    });

    it('should handle escaped quotes before inline comment tokens', () => {
      const jsonWithEscapedQuotes = `{
        "servers": [
          {
            "transport": "sse",
            "name": "escaped-string",
            "url": "https://example.com/sse",
            "headers": {
              "X-Example": "value with escaped quote: \\" // still string"
            }
          }
        ]
      }`;

      const result = parseMcpConfig(jsonWithEscapedQuotes);
      expect(result.servers).toHaveLength(1);
      const server = result.servers[0];
      if (server?.transport !== 'sse') {
        throw new Error('expected sse server');
      }
      expect(server.headers?.['X-Example']).toBe('value with escaped quote: " // still string');
    });

    it('should preserve unicode escapes that decode to quote and slashes inside strings', () => {
      const jsonWithUnicodeEscapes = `{
        "servers": [
          {
            "transport": "sse",
            "name": "unicode-escapes",
            "url": "https://example.com/sse",
            "headers": {
              "X-Example": "unicode: \\u0022 and \\u002F\\u002F remain string text"
            }
          }
        ]
      }`;

      const result = parseMcpConfig(jsonWithUnicodeEscapes);
      expect(result.servers).toHaveLength(1);
      const server = result.servers[0];
      if (server?.transport !== 'sse') {
        throw new Error('expected sse server');
      }
      expect(server.headers?.['X-Example']).toBe('unicode: " and // remain string text');
    });

    it('should throw when block comment is unterminated', () => {
      const unterminatedBlockComment = `{
        "servers": [
          /* unterminated comment
          {
            "transport": "sse",
            "name": "broken",
            "url": "https://example.com/sse"
          }
        ]
      }`;

      expect(() => parseMcpConfig(unterminatedBlockComment)).toThrow(
        /invalid_mcp_config: UnexpectedEndOfComment at line 3, column 11/u
      );
    });

    it('should throw when a string is unterminated during JSONC parsing', () => {
      const unterminatedString = `{
        "servers": [
          {
            "transport": "sse",
            "name": "broken",
            "url": "https://example.com/sse",
            "headers": {
              "X-Example": "unterminated
            }
          }
        ]
      }`;

      expect(() => parseMcpConfig(unterminatedString)).toThrow(
        /invalid_mcp_config: UnexpectedEndOfString at line 8, column 28 \(servers\.0\.headers\.X-Example\)/u
      );
    });
  });
});
