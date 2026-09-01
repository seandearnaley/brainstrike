import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpConfig as parseAgentMcpConfig } from '@brainstrike/agent';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConfig } from '../../mcp-loader';

const appGetPath = vi.hoisted(() => vi.fn());
const decryptStringAsync = vi.hoisted(() => vi.fn());
const isAsyncEncryptionAvailable = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => appGetPath(key),
  },
  safeStorage: {
    decryptStringAsync: (buf: Buffer) => decryptStringAsync(buf),
    isAsyncEncryptionAvailable: () => isAsyncEncryptionAvailable(),
  },
}));

describe('mcp-loader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-loader-'));
    appGetPath.mockReturnValue(tempDir);
    decryptStringAsync.mockReset();
    isAsyncEncryptionAvailable.mockReset();
    isAsyncEncryptionAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    vi.resetModules();
  });

  it('parses valid MCP config and rejects invalid ones', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');

    expect(() => parseMcpConfig('{}')).toThrow('invalid_mcp_config');

    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          { args: ['server.js'], command: 'node', name: 'fs', transport: 'stdio' },
          { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
        ],
      })
    );

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]?.transport).toBe('stdio');
    expect(config.servers[1]?.transport).toBe('sse');

    const interactive = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            args: ['-y', 'mcp-remote', 'https://mcp.example.test/mcp'],
            command: 'npx',
            name: 'interactive-remote',
            transport: 'stdio',
          },
        ],
      })
    );
    expect(interactive.servers[0]?.startup).toBe('authentication-required');
  });

  it('applies one configured-server identity policy at every parser boundary', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');
    for (const name of ['', ' linear', 'linear ', '__proto__', 'linear\nproduction']) {
      expect(() => parseConfiguredMcpServerId(name)).toThrow();
      const input = JSON.stringify({ servers: [{ command: 'node', name, transport: 'stdio' }] });
      expect(() => parseAgentMcpConfig(input)).toThrow();
      expect(() => parseMcpConfig(input)).toThrow();
    }
  });

  it('requires explicit user startup for native OAuth HTTP servers', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');
    const nativeOAuth = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            auth: { scopes: ['read'], type: 'oauth-user' },
            name: 'linear',
            protocol: 'auto',
            transport: 'streamable-http',
            url: 'https://mcp.linear.app/mcp',
          },
        ],
      })
    );
    expect(nativeOAuth.servers[0]?.startup).toBe('authentication-required');
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              auth: { type: 'oauth-user' },
              name: 'linear',
              protocol: 'auto',
              startup: 'automatic',
              transport: 'streamable-http',
              url: 'https://mcp.linear.app/mcp',
            },
          ],
        })
      )
    ).toThrow(/OAuth user authentication requires startup "authentication-required"/u);
  });

  it('surfaces omitted protocol migration without rewriting the JSONC document', async () => {
    const { loadMcpConfig, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const configPath = path.join(tempDir, 'mcp', 'protocol-migration.json');
    const content = `{
      // This comment and formatting must survive migration discovery.
      "servers": [{ "command": "node", "name": "legacy", "transport": "stdio" }]
    }`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, 'utf-8');
    await setCustomMcpConfigPath(configPath);

    const loaded = await loadMcpConfig();

    expect(loaded.config?.servers[0]?.protocol).toBe('legacy');
    expect(loaded.migrations).toEqual([
      {
        code: 'mcp_protocol_defaulted_to_legacy',
        serverIndex: 0,
        serverName: 'legacy',
      },
    ]);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
  });

  it('accepts explicit protocol modes and rejects modern policy on legacy SSE', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');
    const auto = { command: 'node', name: 'auto', protocol: 'auto', transport: 'stdio' };
    expect(parseMcpConfig(JSON.stringify({ servers: [auto] })).servers[0]?.protocol).toBe('auto');

    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              name: 'sse',
              protocol: 'auto',
              transport: 'sse',
              url: 'https://example.com/sse',
            },
          ],
        })
      )
    ).toThrow(/legacy SSE transport requires protocol "legacy"/u);
  });

  it('requires an explicit marker for user-paced authentication startup', async () => {
    const { parseMcpConfig } = await import('../../mcp-loader');
    const config = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
            command: 'npx',
            name: 'linear',
            startup: 'authentication-required',
            transport: 'stdio',
          },
        ],
      })
    );

    expect(config.servers[0]).toMatchObject({
      name: 'linear',
      startup: 'authentication-required',
    });
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              command: 'node',
              name: 'invalid',
              startup: 'guess-auth-from-command',
              transport: 'stdio',
            },
          ],
        })
      )
    ).toThrow('invalid_mcp_config');
  });

  it('decrypts encrypted values and applies to headers/env', async () => {
    decryptStringAsync.mockResolvedValue({ result: 'decrypted', shouldReEncrypt: false });
    const { decryptIfEncrypted, withDecryptedSecrets } = await import('../../mcp-loader');

    const encoded = Buffer.from('secret', 'utf-8').toString('base64');

    await expect(decryptIfEncrypted(encoded)).resolves.toBe('decrypted');

    const config: McpConfig = {
      servers: [
        {
          headers: { AuthorizationEncrypted: encoded },
          name: 'remote',
          transport: 'sse',
          url: 'https://example.com/sse',
        },
        {
          command: 'node',
          env: { API_KEYEncrypted: encoded },
          name: 'local',
          transport: 'stdio',
        },
      ],
    };

    const decrypted = await withDecryptedSecrets(config);
    const sseServer = decrypted.servers[0];
    const stdioServer = decrypted.servers[1];
    if (!(sseServer && stdioServer)) {
      throw new Error('expected decrypted SSE and stdio servers');
    }

    if (sseServer.transport === 'sse') {
      expect(sseServer.headers?.['Authorization']).toBe('decrypted');
    }
    if (stdioServer.transport === 'stdio') {
      expect(stdioServer.env?.['API_KEY']).toBe('decrypted');
    }
  });

  it('rejects when decryption fails', async () => {
    decryptStringAsync.mockRejectedValue(new Error('fail'));
    isAsyncEncryptionAvailable.mockResolvedValue(true);
    const { decryptIfEncrypted } = await import('../../mcp-loader');

    const encoded = Buffer.from('plain', 'utf-8').toString('base64');
    await expect(decryptIfEncrypted(encoded)).rejects.toThrow('MCP encrypted value: fail');
  });

  it('rejects when asynchronous safeStorage is unavailable', async () => {
    isAsyncEncryptionAvailable.mockResolvedValue(false);
    decryptStringAsync.mockImplementation(() => {
      throw new Error('fail');
    });
    const { decryptIfEncrypted } = await import('../../mcp-loader');

    const encoded = Buffer.from('plain', 'utf-8').toString('base64');
    await expect(decryptIfEncrypted(encoded)).rejects.toThrow(
      'MCP encrypted value: safeStorage encryption is unavailable'
    );
    expect(decryptStringAsync).not.toHaveBeenCalled();
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
        servers: [{ command: 'node', name: 'fs', transport: 'stdio' }],
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

  it('does not overwrite an existing MCP config when creation is requested', async () => {
    const { readMcpConfigText, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const existingPath = path.join(tempDir, 'mcp', 'existing.json');
    const existingContent = JSON.stringify({
      servers: [{ command: 'node', name: 'existing', transport: 'stdio' }],
    });

    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, existingContent, 'utf-8');
    await setCustomMcpConfigPath(existingPath);

    const doc = await readMcpConfigText(true);
    expect(doc.exists).toBe(true);
    expect(doc.created).toBe(false);
    expect(doc.content).toBe(existingContent);
  });

  it('returns an empty document when MCP config is missing and creation is disabled', async () => {
    const { readMcpConfigText, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const missingPath = path.join(tempDir, 'mcp', 'missing.json');
    await setCustomMcpConfigPath(missingPath);

    const doc = await readMcpConfigText(false);
    expect(doc).toEqual({
      content: '',
      created: false,
      exists: false,
      path: missingPath,
    });
  });

  it('validates before writing MCP config text', async () => {
    const { setCustomMcpConfigPath, writeMcpConfigText } = await import('../../mcp-loader');
    const configPath = path.join(tempDir, 'mcp', 'editable.json');
    await setCustomMcpConfigPath(configPath);

    const invalid = await writeMcpConfigText('{ invalid json');
    expect(invalid.success).toBe(false);

    const valid = await writeMcpConfigText(
      JSON.stringify({
        servers: [{ command: 'node', name: 'fs', transport: 'stdio' }],
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
        servers: [{ command: 'node', name: 'fs', transport: 'stdio' }],
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

  it('falls back to default path when persisted custom path file is unreadable', async () => {
    const persistedPathFile = path.join(tempDir, 'mcp', 'mcp-custom-path.txt');
    fs.mkdirSync(path.dirname(persistedPathFile), { recursive: true });
    fs.mkdirSync(persistedPathFile, { recursive: true }); // EISDIR on readFile

    const { getMcpConfigPath } = await import('../../mcp-loader');
    const resolved = await getMcpConfigPath();

    expect(resolved).toBe(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('keeps in-memory custom path when persisting custom path fails', async () => {
    const userDataAsFile = path.join(tempDir, 'userdata-file');
    fs.writeFileSync(userDataAsFile, 'not-a-directory', 'utf-8');
    appGetPath.mockReturnValue(userDataAsFile);
    vi.resetModules();

    const { getMcpConfigPath, setCustomMcpConfigPath } = await import('../../mcp-loader');
    const customPath = path.join(tempDir, 'mcp', 'persist-fail.json');
    await setCustomMcpConfigPath(customPath);

    await expect(getMcpConfigPath()).resolves.toBe(customPath);
  });

  it('returns the default MCP config template text', async () => {
    const { getDefaultMcpConfigTemplate } = await import('../../mcp-loader');

    const template = getDefaultMcpConfigTemplate();
    expect(template).toContain('"servers"');
    expect(template).toContain('BrainStrike MCP configuration');
    expect(template).toContain('Example: Remote Streamable HTTP server');
    expect(template).toContain('"transport": "streamable-http"');
    expect(template).toContain('"url": "https://your-host.example.com/mcp"');
    expect(template).toContain('Example: Legacy remote SSE server');
    expect(template).toContain('"store": "mcp-credentials"');
    expect(template).not.toContain('YOUR_TOKEN');
    expect(template).not.toContain('"Authorization"');
    expect(template).toContain('Native Linear OAuth (hard read-only endpoint; safest default)');
    expect(template).toContain('"url": "https://mcp.linear.app/mcp/readonly"');
    expect(template).toContain('"scopes": ["read"]');
    expect(template).toContain('Native Linear OAuth (read-write; opt in deliberately)');
    expect(template).not.toContain('"access"');
    expect(template).not.toContain('mcp-remote');
  });

  it('rejects unknown transport entries in withDecryptedSecrets', async () => {
    const { withDecryptedSecrets } = await import('../../mcp-loader');
    const unknownServer = { name: 'unknown-server', transport: 'custom' } as unknown as {
      transport: 'sse' | 'stdio' | 'streamable-http';
      name: string;
    };

    await expect(
      withDecryptedSecrets({
        servers: [unknownServer],
      } as unknown as McpConfig)
    ).rejects.toThrow(/invalid_mcp_config:.*unknown-server.*custom/u);
  });
});
