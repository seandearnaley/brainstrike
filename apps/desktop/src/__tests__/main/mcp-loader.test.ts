import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appGetPath = vi.hoisted(() => vi.fn());
const decryptString = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => appGetPath(key),
  },
  safeStorage: {
    decryptString: (buf: Buffer) => decryptString(buf),
  },
}));

describe('mcp-loader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-loader-'));
    appGetPath.mockReturnValue(tempDir);
    decryptString.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('parses valid MCP config and rejects invalid ones', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');

    expect(() => parseMcpConfig('{}')).toThrow('invalid_mcp_config');

    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          { transport: 'stdio', name: 'fs', command: 'node', args: ['server.js'] },
          { transport: 'sse', name: 'remote', url: 'https://example.com/sse' },
        ],
      })
    );

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]?.transport).toBe('stdio');
    expect(config.servers[1]?.transport).toBe('sse');
  });

  it('decrypts encrypted values and applies to headers/env', async () => {
    decryptString.mockReturnValue('decrypted');
    const { decryptIfEncrypted, withDecryptedSecrets } = await import('../../mcp-loader');

    const encoded = Buffer.from('secret', 'utf-8').toString('base64');

    expect(decryptIfEncrypted(encoded)).toBe('decrypted');

    const config = {
      servers: [
        {
          transport: 'sse',
          name: 'remote',
          url: 'https://example.com/sse',
          headers: { AuthorizationEncrypted: encoded },
        },
        {
          transport: 'stdio',
          name: 'local',
          command: 'node',
          env: { API_KEYEncrypted: encoded },
        },
      ],
    } as const;

    const decrypted = withDecryptedSecrets(config);
    const sseServer = decrypted.servers[0];
    const stdioServer = decrypted.servers[1];

    if (sseServer.transport === 'sse') {
      expect(sseServer.headers?.Authorization).toBe('decrypted');
    }
    if (stdioServer.transport === 'stdio') {
      expect(stdioServer.env?.API_KEY).toBe('decrypted');
    }
  });

  it('returns raw value when decrypt fails', async () => {
    decryptString.mockImplementation(() => {
      throw new Error('fail');
    });
    const { decryptIfEncrypted } = await import('../../mcp-loader');

    const encoded = Buffer.from('plain', 'utf-8').toString('base64');
    expect(decryptIfEncrypted(encoded)).toBe(encoded);
  });

  it('uses custom config path when set', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = await import('../../mcp-loader');

    await setCustomMcpConfigPath('/tmp/custom-mcp.json');
    await expect(getMcpConfigPath()).resolves.toBe('/tmp/custom-mcp.json');

    await setCustomMcpConfigPath(null);
    const fallback = await getMcpConfigPath();
    expect(fallback).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('trims whitespace when setting a custom MCP config path', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const expectedPath = path.join(tempDir, 'mcp', 'trimmed.config.json');

    await setCustomMcpConfigPath(`  ${expectedPath}  `);
    await expect(getMcpConfigPath()).resolves.toBe(expectedPath);
  });

  it('treats whitespace-only custom path input as reset', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = await import('../../mcp-loader');
    await setCustomMcpConfigPath(path.join(tempDir, 'mcp', 'custom.config.json'));

    await setCustomMcpConfigPath('   ');

    const fallback = await getMcpConfigPath();
    expect(fallback).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('rejects relative custom MCP config paths', async () => {
    const { setCustomMcpConfigPath } = await import('../../mcp-loader');

    await expect(setCustomMcpConfigPath('relative/mcp.config.json')).rejects.toThrow(
      'invalid_mcp_config_path: path must be absolute'
    );
  });

  it('ignores invalid persisted relative custom paths from disk', async () => {
    const { getMcpConfigPath } = await import('../../mcp-loader');
    const persistedPathFile = path.join(tempDir, 'mcp', 'mcp-custom-path.txt');
    fs.mkdirSync(path.dirname(persistedPathFile), { recursive: true });
    fs.writeFileSync(persistedPathFile, 'relative/path/from/storage.json', 'utf-8');

    const loadedPath = await getMcpConfigPath();
    expect(loadedPath).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('loads MCP config from disk and reports missing config', async () => {
    const { getMcpConfigPath, loadMcpConfig, setCustomMcpConfigPath } = await import(
      '../../mcp-loader'
    );

    await setCustomMcpConfigPath(null);
    const configPath = await getMcpConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: [{ transport: 'stdio', name: 'fs', command: 'node' }],
      }),
      'utf-8'
    );

    const loaded = await loadMcpConfig();
    expect(loaded.exists).toBe(true);
    expect(loaded.servers).toHaveLength(1);

    await setCustomMcpConfigPath('/tmp/does-not-exist.json');
    const missing = await loadMcpConfig();
    expect(missing.exists).toBe(false);
  });

  it('creates and reads a commented MCP config template when missing', async () => {
    const { readMcpConfigText, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const templatePath = path.join(tempDir, 'mcp', 'template.json');
    await setCustomMcpConfigPath(templatePath);

    const doc = await readMcpConfigText(true);
    expect(doc.exists).toBe(true);
    expect(doc.created).toBe(true);
    expect(doc.path).toBe(templatePath);
    expect(doc.content).toContain('// BrainStrike MCP configuration');
  });

  it('validates before writing MCP config text', async () => {
    const { setCustomMcpConfigPath, writeMcpConfigText } = await import('../../mcp-loader');
    const configPath = path.join(tempDir, 'mcp', 'editable.json');
    await setCustomMcpConfigPath(configPath);

    const invalid = await writeMcpConfigText('{ invalid json');
    expect(invalid.success).toBe(false);

    const valid = await writeMcpConfigText(
      JSON.stringify({
        servers: [{ transport: 'stdio', name: 'fs', command: 'node' }],
      })
    );
    expect(valid.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('returns structured errors when writing MCP config text fails', async () => {
    const { setCustomMcpConfigPath, writeMcpConfigText } = await import('../../mcp-loader');
    const nonDirectoryPath = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(nonDirectoryPath, 'file marker', 'utf-8');
    const configPath = path.join(nonDirectoryPath, 'failing-write.json');
    await setCustomMcpConfigPath(configPath);

    const result = await writeMcpConfigText(
      JSON.stringify({
        servers: [{ transport: 'stdio', name: 'fs', command: 'node' }],
      })
    );

    expect(result.path).toBe(configPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('reports parse errors without treating config as missing', async () => {
    const { getMcpConfigPath, loadMcpConfig, setCustomMcpConfigPath } = await import(
      '../../mcp-loader'
    );

    await setCustomMcpConfigPath(null);
    const configPath = await getMcpConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid json }', 'utf-8');

    const loaded = await loadMcpConfig();
    expect(loaded.exists).toBe(true);
    expect(loaded.config).toBeUndefined();
    expect(loaded.error).toBeDefined();
  });
});
