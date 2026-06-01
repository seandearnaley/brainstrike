import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecryptionToEnv,
  applyDecryptionToHeaders,
  decryptIfEncrypted,
  ensureMcpDirExists,
  getMcpConfigPath,
  loadMcpConfig,
  type McpConfig,
  type McpServer,
  parseMcpConfig,
  setCustomMcpConfigPath,
  watchMcpConfig,
  withDecryptedSecrets,
} from '../../mcp-loader';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
  safeStorage: {
    decryptString: vi.fn(),
  },
}));

// Mock fs modules
vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn(),
  },
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

// Typed helpers for mocked modules
const mockedSafeStorage = vi.mocked(safeStorage);
const mockedFs = vi.mocked(fs as unknown as { watch: ReturnType<typeof vi.fn> });
const mockedFsp = vi.mocked(
  fsp as unknown as {
    mkdir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
  }
);

describe('mcp-loader comprehensive tests', () => {
  const expectedMcpDir = path.join('/mock/user/data', 'mcp');
  const expectedMcpConfigPath = path.join(expectedMcpDir, 'mcp.config.json');

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default behavior: custom path file does not exist
    mockedFsp.readFile.mockImplementation(async (path) => {
      if (path.toString().endsWith('mcp-custom-path.txt')) {
        const error: any = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      }
      return undefined as never;
    });
    // Ensure we start with a clean state for custom path
    try {
      await setCustomMcpConfigPath(null);
    } catch {
      // Ignore errors during reset
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseMcpConfig', () => {
    it('should parse valid stdio server config', () => {
      const json = JSON.stringify({
        servers: [
          {
            transport: 'stdio',
            name: 'test-server',
            command: 'node',
            args: ['server.js'],
            env: { NODE_ENV: 'test' },
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toMatchObject({
        transport: 'stdio',
        name: 'test-server',
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'test' },
      });
    });

    it('should parse valid sse server config', () => {
      const json = JSON.stringify({
        servers: [
          {
            transport: 'sse',
            name: 'sse-server',
            url: 'https://api.example.com/sse',
            headers: { Authorization: 'Bearer token' },
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toMatchObject({
        transport: 'sse',
        name: 'sse-server',
        url: 'https://api.example.com/sse',
        headers: { Authorization: 'Bearer token' },
      });
    });

    it('should parse multiple servers', () => {
      const json = JSON.stringify({
        servers: [
          { transport: 'stdio', name: 'server1', command: 'cmd1' },
          { transport: 'sse', name: 'server2', url: 'http://localhost' },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(2);
    });

    it('should filter out invalid servers', () => {
      const json = JSON.stringify({
        servers: [
          { transport: 'stdio', name: 'valid', command: 'cmd' },
          { transport: 'invalid', name: 'invalid' },
          { transport: 'stdio' }, // missing required fields
          { transport: 'sse', name: 'partial' }, // missing url
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('valid');
    });

    it('should throw for invalid JSON', () => {
      expect(() => parseMcpConfig('invalid json')).toThrow('invalid_mcp_config:');
    });

    it('should throw when servers is not an array', () => {
      const json = JSON.stringify({ servers: 'not-an-array' });
      expect(() => parseMcpConfig(json)).toThrow('invalid_mcp_config: servers must be array');
    });

    it('should allow an empty servers array for template-only configs', () => {
      const json = JSON.stringify({ servers: [] });
      const result = parseMcpConfig(json);
      expect(result.servers).toEqual([]);
    });

    it('should throw when all declared servers are invalid', () => {
      const json = JSON.stringify({
        servers: [{ transport: 'stdio' }, { transport: 'sse', name: 'missing-url' }],
      });

      expect(() => parseMcpConfig(json)).toThrow('invalid_mcp_config: no valid servers');
    });

    it('should throw when servers field is missing', () => {
      const json = JSON.stringify({ other: 'field' });
      expect(() => parseMcpConfig(json)).toThrow('invalid_mcp_config: servers must be array');
    });

    it('should handle stdio server without optional fields', () => {
      const json = JSON.stringify({
        servers: [{ transport: 'stdio', name: 'minimal', command: 'cmd' }],
      });

      const result = parseMcpConfig(json);
      expect(result.servers[0]).toEqual({
        transport: 'stdio',
        name: 'minimal',
        command: 'cmd',
      });
    });

    it('should handle sse server without optional headers', () => {
      const json = JSON.stringify({
        servers: [{ transport: 'sse', name: 'minimal-sse', url: 'http://example.com' }],
      });

      const result = parseMcpConfig(json);
      expect(result.servers[0]).toEqual({
        transport: 'sse',
        name: 'minimal-sse',
        url: 'http://example.com',
      });
    });

    it('should filter non-string args in stdio server', () => {
      const json = JSON.stringify({
        servers: [
          {
            transport: 'stdio',
            name: 'test',
            command: 'node',
            args: ['valid', 123, null, 'another'],
          },
        ],
      });

      const result = parseMcpConfig(json);
      expect(result.servers[0].args).toEqual(['valid', 'another']);
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
      if (server.transport !== 'sse') {
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
      if (server.transport !== 'sse') {
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
      if (server.transport !== 'sse') {
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
        'invalid_mcp_config: unterminated block comment'
      );
    });

    it('should throw when string is unterminated during JSONC stripping', () => {
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
        'invalid_mcp_config: unterminated string'
      );
    });
  });

  describe('getMcpConfigPath', () => {
    it('should return correct path', async () => {
      const configPath = await getMcpConfigPath();
      expect(configPath).toBe(expectedMcpConfigPath);
      expect(app.getPath).toHaveBeenCalledWith('userData');
    });
  });

  describe('ensureMcpDirExists', () => {
    it('should create directory with recursive option', async () => {
      await ensureMcpDirExists();
      expect(fsp.mkdir).toHaveBeenCalledWith(expectedMcpDir, { recursive: true });
    });
  });

  describe('decryptIfEncrypted', () => {
    it('should decrypt base64 encoded value with safeStorage', () => {
      const mockDecrypted = 'decrypted-value';
      mockedSafeStorage.decryptString.mockReturnValue(mockDecrypted as never);

      const encrypted = Buffer.from('test-value').toString('base64');
      const result = decryptIfEncrypted(encrypted);

      expect(result).toBe(mockDecrypted);
      expect(safeStorage.decryptString).toHaveBeenCalled();
    });

    it('should fallback to base64 decode when safeStorage unavailable', () => {
      // Temporarily disable decryptString
      const s = safeStorage as unknown as { decryptString?: ((buf: Buffer) => string) | undefined };
      const original = s.decryptString;
      s.decryptString = undefined;

      const value = 'test-value';
      const encrypted = Buffer.from(value).toString('base64');
      const result = decryptIfEncrypted(encrypted);

      expect(result).toBe(value);

      // Restore
      s.decryptString = original;
    });

    it('should return original value if decryption fails', () => {
      mockedSafeStorage.decryptString.mockImplementation(() => {
        throw new Error('Decrypt failed');
      });

      const result = decryptIfEncrypted('not-base64');
      expect(result).toBe('not-base64');
    });
  });

  describe('applyDecryptionToHeaders', () => {
    beforeEach(() => {
      mockedSafeStorage.decryptString.mockImplementation((buf: Buffer) => buf.toString('utf-8'));
    });

    it('should decrypt encrypted headers', () => {
      const headers = {
        AuthorizationEncrypted: Buffer.from('Bearer token').toString('base64'),
        'X-API-Key': 'plain-key',
      };

      const result = applyDecryptionToHeaders(headers);
      expect(result).toEqual({
        Authorization: 'Bearer token',
        'X-API-Key': 'plain-key',
      });
    });

    it('should handle undefined headers', () => {
      const result = applyDecryptionToHeaders(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle empty headers', () => {
      const result = applyDecryptionToHeaders({});
      expect(result).toEqual({});
    });

    it('should not override existing keys', () => {
      const headers = {
        Authorization: 'existing',
        AuthorizationEncrypted: Buffer.from('new').toString('base64'),
      };

      const result = applyDecryptionToHeaders(headers);
      expect(result?.Authorization).toBe('new');
    });
  });

  describe('applyDecryptionToEnv', () => {
    beforeEach(() => {
      mockedSafeStorage.decryptString.mockImplementation((buf: Buffer) => buf.toString('utf-8'));
    });

    it('should decrypt encrypted env vars', () => {
      const env = {
        API_KEYEncrypted: Buffer.from('secret-key').toString('base64'),
        NODE_ENV: 'test',
      };

      const result = applyDecryptionToEnv(env);
      expect(result).toEqual({
        API_KEY: 'secret-key',
        NODE_ENV: 'test',
      });
    });

    it('should handle undefined env', () => {
      const result = applyDecryptionToEnv(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle empty env', () => {
      const result = applyDecryptionToEnv({});
      expect(result).toEqual({});
    });
  });

  describe('withDecryptedSecrets', () => {
    beforeEach(() => {
      mockedSafeStorage.decryptString.mockImplementation((buf: Buffer) => buf.toString('utf-8'));
    });

    it('should decrypt SSE server headers', () => {
      const config: McpConfig = {
        servers: [
          {
            transport: 'sse',
            name: 'test',
            url: 'http://example.com',
            headers: {
              AuthorizationEncrypted: Buffer.from('Bearer token').toString('base64'),
            },
          },
        ],
      };

      const result = withDecryptedSecrets(config);
      expect(result.servers[0]).toMatchObject({
        transport: 'sse',
        name: 'test',
        url: 'http://example.com',
        headers: { Authorization: 'Bearer token' },
      });
    });

    it('should decrypt stdio server env', () => {
      const config: McpConfig = {
        servers: [
          {
            transport: 'stdio',
            name: 'test',
            command: 'node',
            env: {
              API_KEYEncrypted: Buffer.from('secret').toString('base64'),
            },
          },
        ],
      };

      const result = withDecryptedSecrets(config);
      expect(result.servers[0]).toMatchObject({
        transport: 'stdio',
        name: 'test',
        command: 'node',
        env: { API_KEY: 'secret' },
      });
    });

    it('should handle servers without secrets', () => {
      const config: McpConfig = {
        servers: [
          { transport: 'stdio', name: 'plain', command: 'cmd' },
          { transport: 'sse', name: 'plain-sse', url: 'http://example.com' },
        ],
      };

      const result = withDecryptedSecrets(config);
      expect(result).toEqual(config);
    });

    it('should remove undefined headers after decryption', () => {
      const config: McpConfig = {
        servers: [
          {
            transport: 'sse',
            name: 'test',
            url: 'http://example.com',
            headers: undefined,
          } as McpServer,
        ],
      };

      const result = withDecryptedSecrets(config);
      expect('headers' in result.servers[0]).toBe(false);
    });

    it('should remove undefined env after decryption', () => {
      const config: McpConfig = {
        servers: [
          {
            transport: 'stdio',
            name: 'test',
            command: 'cmd',
            env: undefined,
          } as McpServer,
        ],
      };

      const result = withDecryptedSecrets(config);
      expect('env' in result.servers[0]).toBe(false);
    });
  });

  describe('loadMcpConfig', () => {
    it('should load and parse config successfully', async () => {
      const mockConfig = {
        servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.servers).toHaveLength(1);
      expect(result.loadedAt).toBeDefined();
      expect(fsp.readFile).toHaveBeenCalledWith(expectedMcpConfigPath, 'utf-8');
    });

    it('should handle file not found', async () => {
      type NodeError = Error & { code?: string };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        const error: NodeError = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(false);
      expect(result.config).toBeUndefined();
      expect(result.servers).toBeUndefined();
    });

    it('should handle no such file error message', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        throw new Error('no such file or directory');
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(false);
    });

    it('should handle other errors', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        throw new Error('Permission denied');
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.config).toBeUndefined();
      expect(result.error).toContain('Permission denied');
    });

    it('should handle invalid JSON', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return 'invalid json' as never;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe('watchMcpConfig', () => {
    let mockWatcher: { close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.useFakeTimers();
      mockWatcher = { close: vi.fn() };
      mockedFs.watch.mockReturnValue(mockWatcher as never);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should setup watcher and call onChange on config changes', async () => {
      const onChange = vi.fn();
      const mockConfig = {
        servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      const watcher = await watchMcpConfig(onChange);

      // Simulate file change
      const watchCallback = mockedFs.watch.mock.calls[0][1] as (
        eventType: string,
        filename?: string | undefined
      ) => void;
      watchCallback('change', 'mcp.config.json');

      // Advance timers to trigger debounced callback
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).toHaveBeenCalled();
      const callArg = onChange.mock.calls[0][0];
      expect(callArg.exists).toBe(true);
      expect(callArg.config).toBeDefined();

      watcher.close();
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should ignore non-mcp.config.json file changes', async () => {
      const onChange = vi.fn();
      await watchMcpConfig(onChange);

      const watchCallback = mockedFs.watch.mock.calls[0][1] as (
        eventType: string,
        filename?: string | undefined
      ) => void;
      watchCallback('change', 'other-file.json');

      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should watch the selected config basename for custom paths', async () => {
      const onChange = vi.fn();
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          return '/custom/location/custom-mcp.json' as never;
        }
        return JSON.stringify({
          servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }],
        }) as never;
      });

      await watchMcpConfig(onChange);

      const watchCallback = mockedFs.watch.mock.calls[0][1] as (
        eventType: string,
        filename?: string | undefined
      ) => void;

      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();

      watchCallback('change', 'custom-mcp.json');
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('should debounce rapid changes', async () => {
      const onChange = vi.fn();
      const mockConfig = {
        servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      await watchMcpConfig(onChange);

      const watchCallback = mockedFs.watch.mock.calls[0][1] as (
        eventType: string,
        filename?: string | undefined
      ) => void;

      // Rapid changes
      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(50);
      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(50);
      watchCallback('change', 'mcp.config.json');

      // Only final timeout should trigger
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('should handle undefined filename', async () => {
      const onChange = vi.fn();
      await watchMcpConfig(onChange);

      const watchCallback = mockedFs.watch.mock.calls[0][1] as (
        eventType: string,
        filename?: string | undefined
      ) => void;
      watchCallback('change', undefined);

      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should ensure directory exists', async () => {
      await watchMcpConfig(vi.fn());
      // Wait a tick for the void ensureMcpDirExists() call to complete
      await vi.waitFor(() => {
        expect(fsp.mkdir).toHaveBeenCalledWith(expectedMcpDir, { recursive: true });
      });
    });
  });
});
