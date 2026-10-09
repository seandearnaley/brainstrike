import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpConfig as parseAgentMcpConfig } from '@brainstrike/agent';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMcpConfigFile,
  getDefaultMcpConfigTemplate,
  parseMcpConfig,
} from '../src/mcp/config-file.js';

/** One fresh config-file instance for a profile directory, under the loader's names. */
function loader(userDataDir: string) {
  const file = createMcpConfigFile(userDataDir);
  return {
    getDefaultMcpConfigTemplate,
    getMcpConfigPath: () => file.path(),
    loadMcpConfig: () => file.load(),
    parseMcpConfig,
    readMcpConfigText: (createIfMissing?: boolean) => file.readText(createIfMissing),
    setCustomMcpConfigPath: (configPath: string | null) => file.setCustomPath(configPath),
    writeMcpConfigText: (content: string) => file.writeText(content),
  };
}

describe('MCP config file', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-file-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('parses valid MCP config and rejects invalid ones', async () => {
    const { parseMcpConfig } = loader(tempDir);

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
    const { parseMcpConfig } = loader(tempDir);
    for (const name of ['', ' linear', 'linear ', '__proto__', 'linear\nproduction']) {
      expect(() => parseConfiguredMcpServerId(name)).toThrow();
      const input = JSON.stringify({ servers: [{ command: 'node', name, transport: 'stdio' }] });
      expect(() => parseAgentMcpConfig(input)).toThrow();
      expect(() => parseMcpConfig(input)).toThrow();
    }
  });

  it('requires explicit user startup for native OAuth HTTP servers', async () => {
    const { parseMcpConfig } = loader(tempDir);
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
    const { loadMcpConfig, setCustomMcpConfigPath } = loader(tempDir);
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
    const { parseMcpConfig } = loader(tempDir);
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
    const { parseMcpConfig } = loader(tempDir);
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

  it('refuses safeStorage-encrypted header and env values visibly', () => {
    const encoded = Buffer.from('secret', 'utf-8').toString('base64');
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              headers: { AuthorizationEncrypted: encoded },
              name: 'remote',
              protocol: 'legacy',
              transport: 'sse',
              url: 'https://example.com/sse',
            },
          ],
        })
      )
    ).toThrow(
      'invalid_mcp_config: MCP server "remote" value "AuthorizationEncrypted" holds an Electron safeStorage secret, which the agent host does not read; use a bearer credential reference'
    );
    expect(() =>
      parseMcpConfig(
        JSON.stringify({
          servers: [
            {
              command: 'node',
              env: { API_KEYEncrypted: encoded },
              name: 'local',
              protocol: 'legacy',
              transport: 'stdio',
            },
          ],
        })
      )
    ).toThrow(/MCP server "local" value "API_KEYEncrypted"/u);
  });

  it('reports a stored encrypted value as a load error and refuses to save one', async () => {
    const file = createMcpConfigFile(tempDir);
    const configPath = await file.path();
    const content = JSON.stringify({
      servers: [
        {
          command: 'node',
          env: { TOKENEncrypted: 'c2VjcmV0' },
          name: 'local',
          protocol: 'legacy',
          transport: 'stdio',
        },
      ],
    });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, 'utf-8');

    const loaded = await file.load();
    expect(loaded).toMatchObject({ exists: true, path: configPath });
    expect(loaded.error).toContain('"TOKENEncrypted"');
    expect(loaded.config).toBeUndefined();

    fs.rmSync(configPath);
    const written = await file.writeText(content);
    expect(written.success).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('uses custom config path when set', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = loader(tempDir);

    await setCustomMcpConfigPath('/tmp/custom-mcp.json');
    await expect(getMcpConfigPath()).resolves.toBe('/tmp/custom-mcp.json');

    await setCustomMcpConfigPath(null);
    const fallback = await getMcpConfigPath();
    expect(fallback).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('trims whitespace when setting a custom MCP config path', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = loader(tempDir);
    const expectedPath = path.join(tempDir, 'mcp', 'trimmed.config.json');

    await setCustomMcpConfigPath(`  ${expectedPath}  `);
    await expect(getMcpConfigPath()).resolves.toBe(expectedPath);
  });

  it('treats whitespace-only custom path input as reset', async () => {
    const { getMcpConfigPath, setCustomMcpConfigPath } = loader(tempDir);
    await setCustomMcpConfigPath(path.join(tempDir, 'mcp', 'custom.config.json'));

    await setCustomMcpConfigPath('   ');

    const fallback = await getMcpConfigPath();
    expect(fallback).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('rejects relative custom MCP config paths', async () => {
    const { setCustomMcpConfigPath } = loader(tempDir);

    await expect(setCustomMcpConfigPath('relative/mcp.config.json')).rejects.toThrow(
      'invalid_mcp_config_path: path must be absolute'
    );
  });

  it('ignores invalid persisted relative custom paths from disk', async () => {
    const { getMcpConfigPath } = loader(tempDir);
    const persistedPathFile = path.join(tempDir, 'mcp', 'mcp-custom-path.txt');
    fs.mkdirSync(path.dirname(persistedPathFile), { recursive: true });
    fs.writeFileSync(persistedPathFile, 'relative/path/from/storage.json', 'utf-8');

    const loadedPath = await getMcpConfigPath();
    expect(loadedPath).toContain(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('loads MCP config from disk and reports missing config', async () => {
    const { getMcpConfigPath, loadMcpConfig, setCustomMcpConfigPath } = loader(tempDir);

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
    const { readMcpConfigText, setCustomMcpConfigPath } = loader(tempDir);
    const templatePath = path.join(tempDir, 'mcp', 'template.json');
    await setCustomMcpConfigPath(templatePath);

    const doc = await readMcpConfigText(true);
    expect(doc.exists).toBe(true);
    expect(doc.created).toBe(true);
    expect(doc.path).toBe(templatePath);
    expect(doc.content).toContain('// BrainStrike MCP configuration');
  });

  it('does not overwrite an existing MCP config when creation is requested', async () => {
    const { readMcpConfigText, setCustomMcpConfigPath } = loader(tempDir);
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
    const { readMcpConfigText, setCustomMcpConfigPath } = loader(tempDir);
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
    const { setCustomMcpConfigPath, writeMcpConfigText } = loader(tempDir);
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

  it('reports saved SSE OAuth as a config error while preserving its raw JSONC for repair', async () => {
    const { loadMcpConfig, readMcpConfigText, setCustomMcpConfigPath, writeMcpConfigText } =
      loader(tempDir);
    const configPath = path.join(tempDir, 'legacy-oauth.jsonc');
    const content = `{
      // Keep this user's comment, whitespace, and omitted protocol.
      "servers": [{ "name": "legacy", "transport": "sse", "url": "https://example.test/sse", "auth": { "type": "oauth-user" } }],
    }`;
    fs.writeFileSync(configPath, content, 'utf-8');
    await setCustomMcpConfigPath(configPath);
    const error =
      'invalid_mcp_config: servers.0.auth: auth "oauth-user" is not supported with transport "sse"; use "streamable-http"';

    expect(await readMcpConfigText(true)).toEqual({
      content,
      created: false,
      error,
      exists: true,
      path: configPath,
    });
    expect(await loadMcpConfig()).toEqual({ error, exists: true, path: configPath });
    expect(await writeMcpConfigText(content)).toEqual({ error, path: configPath, success: false });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);

    const corrected = content.replace('"transport": "sse"', '"transport": "streamable-http"');
    expect(await writeMcpConfigText(corrected)).toEqual({ path: configPath, success: true });
    expect(await readMcpConfigText()).toEqual({
      content: corrected,
      created: false,
      exists: true,
      path: configPath,
    });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(corrected);
  });

  it('returns JSONC syntax diagnostics with the raw editable document', async () => {
    const { readMcpConfigText, setCustomMcpConfigPath } = loader(tempDir);
    const configPath = path.join(tempDir, 'invalid.jsonc');
    const content = '{ invalid json }';
    fs.writeFileSync(configPath, content, 'utf-8');
    await setCustomMcpConfigPath(configPath);
    expect(await readMcpConfigText()).toMatchObject({
      content,
      error: expect.stringContaining('invalid_mcp_config:'),
      exists: true,
    });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
  });

  it('returns structured errors when writing MCP config text fails', async () => {
    const { setCustomMcpConfigPath, writeMcpConfigText } = loader(tempDir);
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
    const { getMcpConfigPath, loadMcpConfig, setCustomMcpConfigPath } = loader(tempDir);

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

    const { getMcpConfigPath } = loader(tempDir);
    const resolved = await getMcpConfigPath();

    expect(resolved).toBe(path.join(tempDir, 'mcp', 'mcp.config.json'));
  });

  it('keeps in-memory custom path when persisting custom path fails', async () => {
    const userDataAsFile = path.join(tempDir, 'userdata-file');
    fs.writeFileSync(userDataAsFile, 'not-a-directory', 'utf-8');

    const { getMcpConfigPath, setCustomMcpConfigPath } = loader(userDataAsFile);
    const customPath = path.join(tempDir, 'mcp', 'persist-fail.json');
    await setCustomMcpConfigPath(customPath);

    await expect(getMcpConfigPath()).resolves.toBe(customPath);
  });

  it('returns the default MCP config template text', async () => {
    const { getDefaultMcpConfigTemplate } = loader(tempDir);

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
});
