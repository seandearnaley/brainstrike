import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsHarness,
  enabledById,
  type SettingsHarness,
  stdioServer,
  toolList,
} from './mcp-settings-authority-harness.js';

let harness: SettingsHarness | undefined;
async function setup(options?: Parameters<typeof createSettingsHarness>[0]) {
  harness = await createSettingsHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

describe('MCP settings authority startup', () => {
  it('applies the stored extension opt-out before committing the config, then discovers its tools', async () => {
    const h = await setup({ listTools: async () => toolList('read', 'write') });
    await h.writeStoredExtensions({ v1: { apps: false, tasks: true } });
    await h.writeConfig([stdioServer('fs')]);

    await h.authority.start();

    expect(h.setMcpExtensionPreferences).toHaveBeenCalledWith({ apps: false, tasks: true });
    expect(h.setMcpExtensionPreferences.mock.invocationCallOrder[0]).toBeLessThan(
      h.replaceResolvedConfig.mock.invocationCallOrder[0] ?? 0
    );
    expect(h.replaceResolvedConfig).toHaveBeenCalledWith({
      servers: [expect.objectContaining({ name: 'fs', transport: 'stdio' })],
    });
    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': true });
    expect(h.events).toEqual([
      {
        config: expect.objectContaining({
          exists: true,
          path: h.configPath,
          servers: [{ name: 'fs', protocol: 'legacy', transport: 'stdio' }],
        }),
        type: 'config',
      },
      { tools: { fs: expect.any(Array) }, type: 'tools' },
    ]);
  });

  it('fails closed when the stored extension preference cannot be read', async () => {
    const h = await setup();
    h.settings.values.set('mcp.extensionPreferences', '{not json');

    await h.authority.start();

    expect(h.setMcpExtensionPreferences).toHaveBeenCalledWith({ apps: false, tasks: false });
  });

  it('installs an empty authority for an absent config', async () => {
    const h = await setup();

    await h.authority.start();

    expect(h.replaceResolvedConfig).toHaveBeenCalledWith({ servers: [] });
    expect(h.events[0]).toEqual({
      config: { exists: false, path: h.configPath },
      type: 'config',
    });
    expect(h.activeWatcher()).toBeDefined();
  });

  it('discovers only committed servers and never invokes an authentication-required one', async () => {
    const listTools = vi.fn(async () => toolList('read'));
    const h = await setup({ listTools });
    await h.writeConfig([
      stdioServer('fs'),
      {
        auth: { type: 'oauth-user' },
        name: 'linear',
        protocol: '2026-07-28',
        transport: 'streamable-http',
        url: 'https://mcp.linear.app/mcp',
      },
    ]);

    await h.authority.start();

    expect(listTools.mock.calls).toEqual([[parseConfiguredMcpServerId('fs')]]);
    expect(enabledById()).toEqual({ 'fs.read': true });
  });

  it('skips a server that reports duplicate tool names without a partial registry', async () => {
    const h = await setup({
      listTools: async (serverId) =>
        serverId === parseConfiguredMcpServerId('dup') ? toolList('same', 'same') : toolList('ok'),
    });
    await h.writeConfig([stdioServer('dup'), stdioServer('fs')]);

    await h.authority.start();

    expect(enabledById()).toEqual({ 'fs.ok': true });
  });
});

describe('MCP settings authority watched config changes', () => {
  it('commits a changed config and rediscovers its tools', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await h.writeConfig([stdioServer('fs'), stdioServer('git')]);
    await h.fireWatch();

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'fs' }), expect.objectContaining({ name: 'git' })],
    });
    expect(enabledById()).toEqual({ 'fs.read': true, 'git.read': true });
  });

  it('keeps the committed authority and tools when a watched config is malformed', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const commits = h.replaceResolvedConfig.mock.calls.length;

    await writeFile(h.configPath, '{ invalid json }', 'utf8');
    await h.fireWatch();

    expect(h.replaceResolvedConfig).toHaveBeenCalledTimes(commits);
    expect(enabledById()).toEqual({ 'fs.read': true });
    expect(h.events.at(-1)).toEqual({
      config: expect.objectContaining({ error: expect.stringContaining('invalid_mcp_config') }),
      type: 'config',
    });
  });

  it('installs an empty authority when the config file is removed', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await rm(h.configPath);
    await h.fireWatch();

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
    expect(enabledById()).toEqual({});
  });

  it('drops a slow discovery that a newer committed config superseded', async () => {
    const slow = Promise.withResolvers<ReturnType<typeof toolList>>();
    const h = await setup({
      listTools: async (serverId) =>
        serverId === parseConfiguredMcpServerId('slow') ? await slow.promise : toolList('fast'),
    });
    await h.writeConfig([stdioServer('slow')]);
    const started = h.authority.start();
    await vi.waitFor(() => expect(h.activeWatcher()).toBeDefined());
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalled());

    await h.writeConfig([stdioServer('quick')]);
    await h.fireWatch();
    slow.resolve(toolList('stale'));
    await started;

    expect(enabledById()).toEqual({ 'quick.fast': true });
  });
});

describe('MCP settings authority config text and path', () => {
  it('saves valid text, reloads it, and keeps a watcher on the file', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.authority.start();
    const firstWatcher = h.activeWatcher();
    const content = JSON.stringify({ servers: [stdioServer('fs')] });

    await expect(h.authority.writeConfigText({ content })).resolves.toEqual({
      path: h.configPath,
      success: true,
    });

    expect(await readFile(h.configPath, 'utf8')).toBe(content);
    expect(firstWatcher?.close).toHaveBeenCalled();
    expect(h.activeWatcher()).toBeDefined();
    expect(h.activeWatcher()).not.toBe(firstWatcher);
    expect(enabledById()).toEqual({ 'fs.read': true });
  });

  it('returns a validation failure without saving or reloading', async () => {
    const h = await setup();
    await h.authority.start();
    const commits = h.replaceResolvedConfig.mock.calls.length;

    const result = await h.authority.writeConfigText({ content: '{"servers": [{}]}' });

    expect(result).toMatchObject({ path: h.configPath, success: false });
    expect(existsSync(h.configPath)).toBe(false);
    expect(h.replaceResolvedConfig).toHaveBeenCalledTimes(commits);
  });

  it('refuses empty and oversized text before writing', async () => {
    const h = await setup();
    await h.authority.start();

    await expect(h.authority.writeConfigText({ content: '   ' })).resolves.toEqual({
      error: 'MCP config content cannot be empty',
      path: h.configPath,
      success: false,
    });
    await expect(
      h.authority.writeConfigText({ content: `{"servers":[]}${' '.repeat(1_000_001)}` })
    ).resolves.toEqual({
      error: 'MCP config exceeds 1000000 bytes',
      path: h.configPath,
      success: false,
    });
    expect(existsSync(h.configPath)).toBe(false);
  });

  it('refuses saved text holding a safeStorage-encrypted value', async () => {
    const h = await setup();
    await h.authority.start();
    const content = JSON.stringify({
      servers: [{ ...stdioServer('local'), env: { TOKENEncrypted: 'c2VjcmV0' } }],
    });

    const result = await h.authority.writeConfigText({ content });

    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error).toContain('"TOKENEncrypted"');
    expect(existsSync(h.configPath)).toBe(false);
  });

  it('restores the default path, reloads it and watches it', async () => {
    const h = await setup();
    await h.authority.start();
    const custom = path.join(h.userDataDir, 'mcp', 'custom.json');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, JSON.stringify({ servers: [stdioServer('fs')] }), 'utf8');
    await h.authority.setConfigPath({ path: custom });

    await expect(h.authority.setConfigPath({ path: null })).resolves.toEqual({
      path: h.configPath,
      success: true,
    });
    await expect(h.authority.configPath()).resolves.toEqual({ path: h.configPath });
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
  });

  it('accepts a path inside the profile mcp directory', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.authority.start();
    const custom = path.join(h.userDataDir, 'mcp', 'custom.json');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, JSON.stringify({ servers: [stdioServer('fs')] }), 'utf8');

    await expect(h.authority.setConfigPath({ path: custom })).resolves.toEqual({
      path: custom,
      success: true,
    });
    expect(enabledById()).toEqual({ 'fs.read': true });
  });

  it('refuses an arbitrary path the native picker did not choose', async () => {
    const h = await setup();
    await h.authority.start();
    const elsewhere = path.join(path.dirname(h.userDataDir), 'elsewhere.json');

    await expect(h.authority.setConfigPath({ path: elsewhere })).rejects.toThrow(
      'MCP config path must be selected with the native file picker.'
    );
    await expect(h.authority.setConfigPath({ path: 'relative.json' })).rejects.toThrow(
      'MCP config path must be an absolute path selected by the user.'
    );
    await expect(h.authority.configPath()).resolves.toEqual({ path: h.configPath });
  });

  it('selects a picked file and allows naming it again later', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.authority.start();
    const picked = path.join(h.userDataDir, 'picked', 'mcp.json');
    await mkdir(path.dirname(picked), { recursive: true });
    await writeFile(picked, JSON.stringify({ servers: [stdioServer('fs')] }), 'utf8');

    await expect(h.authority.pickConfigPath(picked)).resolves.toEqual({
      path: picked,
      success: true,
    });
    expect(enabledById()).toEqual({ 'fs.read': true });
    await h.authority.setConfigPath({ path: null });
    await expect(h.authority.setConfigPath({ path: picked })).resolves.toEqual({
      path: picked,
      success: true,
    });
  });

  it('writes the sample config and refuses to overwrite an existing file', async () => {
    const h = await setup();
    await h.authority.start();

    await expect(h.authority.createSampleConfig()).resolves.toEqual({
      path: h.configPath,
      success: true,
    });
    const sample = await readFile(h.configPath, 'utf8');
    expect(sample).toContain('"servers"');
    await expect(h.authority.createSampleConfig()).resolves.toEqual({
      error:
        'MCP config already exists. Select the existing file or reset the path before creating a sample.',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(sample);
  });
});

describe('MCP settings authority extension dials', () => {
  it('persists, applies and announces a change', async () => {
    const h = await setup();
    await h.authority.start();

    await expect(h.authority.setExtensions({ apps: false, tasks: true })).resolves.toEqual({
      apps: false,
      tasks: true,
    });

    expect(JSON.parse(h.settings.values.get('mcp.extensionPreferences') ?? 'null')).toEqual({
      v1: { apps: false, tasks: true },
    });
    expect(h.setMcpExtensionPreferences).toHaveBeenLastCalledWith({ apps: false, tasks: true });
    await expect(h.authority.extensions()).resolves.toEqual({ apps: false, tasks: true });
    expect(h.events.at(-1)).toEqual({
      extensions: { apps: false, tasks: true },
      type: 'extensions',
    });
  });

  it('rejects a malformed change without persisting or applying it', async () => {
    const h = await setup();
    await h.authority.start();
    const applied = h.setMcpExtensionPreferences.mock.calls.length;

    await expect(h.authority.setExtensions({ apps: 1 } as never)).rejects.toThrow();

    expect(h.settings.store.setSetting).not.toHaveBeenCalled();
    expect(h.setMcpExtensionPreferences).toHaveBeenCalledTimes(applied);
  });

  it('never applies a change whose write failed', async () => {
    const h = await setup();
    await h.authority.start();
    const applied = h.setMcpExtensionPreferences.mock.calls.length;
    h.settings.store.setSetting.mockRejectedValueOnce(new Error('state store closed'));

    await expect(h.authority.setExtensions({ apps: true, tasks: false })).rejects.toThrow(
      'state store closed'
    );

    expect(h.setMcpExtensionPreferences).toHaveBeenCalledTimes(applied);
  });
});

describe('MCP settings authority lifecycle control', () => {
  it('rediscovers after a connect succeeds', async () => {
    const listTools = vi.fn(async () => toolList('read'));
    const h = await setup({ listTools });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const discoveries = listTools.mock.calls.length;
    h.control.mockImplementationOnce(async (request) => ({
      configuredProtocol: 'legacy',
      configuredServerId: request.configuredServerId,
      generation: 2,
      negotiated: { era: 'legacy', revision: '2025-06-18' },
      state: 'connected',
      transport: 'stdio',
    }));

    await expect(
      h.authority.control({
        action: 'connect',
        configuredServerId: parseConfiguredMcpServerId('fs'),
      })
    ).resolves.toMatchObject({ state: 'connected' });

    expect(listTools.mock.calls.length).toBe(discoveries + 1);
  });

  it('reloads after a destructive control even when the control fails', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const commits = h.replaceResolvedConfig.mock.calls.length;
    h.control.mockRejectedValueOnce(new Error('disconnect failed'));

    await expect(
      h.authority.control({
        action: 'disconnect',
        configuredServerId: parseConfiguredMcpServerId('fs'),
      })
    ).rejects.toThrow('disconnect failed');

    expect(h.replaceResolvedConfig).toHaveBeenCalledTimes(commits + 1);
  });

  it('reports both failures when a destructive control and its reload fail', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    h.control.mockRejectedValueOnce(new Error('reauthorize failed'));
    h.replaceResolvedConfig.mockRejectedValueOnce(new Error('reload failed'));

    const failure = await h.authority
      .control({ action: 'reauthorize', configuredServerId: parseConfiguredMcpServerId('fs') })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      'reauthorize failed',
      'reload failed',
    ]);
  });

  it('cancels without waiting behind queued config work', async () => {
    const slow = Promise.withResolvers<ReturnType<typeof toolList>>();
    const h = await setup({ listTools: async () => await slow.promise });
    await h.writeConfig([stdioServer('fs')]);
    const started = h.authority.start();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalled());

    await expect(
      h.authority.control({
        action: 'cancel',
        configuredServerId: parseConfiguredMcpServerId('fs'),
      })
    ).resolves.toMatchObject({ configuredServerId: 'fs' });

    slow.resolve(toolList());
    await started;
  });
});

describe('MCP settings authority shutdown and snapshot', () => {
  it('answers the config status, dials, server status and tools in one snapshot', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await expect(h.authority.snapshot()).resolves.toEqual({
      config: expect.objectContaining({ exists: true, path: h.configPath }),
      extensions: { apps: true, tasks: true },
      status: h.publisher.snapshot(),
      tools: { fs: [expect.objectContaining({ enabled: true, id: 'fs.read' })] },
    });
  });

  it('stops the watcher, clears the registry and refuses later operations on close', async () => {
    const h = await setup({ listTools: async () => toolList('read') });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const watcher = h.activeWatcher();

    await h.authority.close();

    expect(watcher?.close).toHaveBeenCalled();
    expect(enabledById()).toEqual({});
    await expect(h.authority.configStatus()).rejects.toThrow(
      'MCP settings lifecycle is closed for cleanup'
    );
    await expect(
      h.authority.setToolsEnabled({ enabled: false, toolIds: ['fs.read'] })
    ).rejects.toThrow('MCP settings lifecycle is closed for cleanup');
  });
});
