import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSettingsHarness,
  enabledById,
  type ListTools,
  type SettingsHarness,
  stdioServer,
  toolList,
} from './mcp-settings-authority-harness.js';

let harness: SettingsHarness | undefined;
async function setup(listTools: ListTools = async () => toolList('read', 'write')) {
  harness = await createSettingsHarness({ listTools });
  return harness;
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

function stored(preferences: { disabledTools: string[]; enabledTools: string[] }) {
  return { ...preferences, lastUpdated: 0, version: 1 };
}

describe('MCP tool preferences', () => {
  it('applies saved choices after discovery', async () => {
    const h = await setup();
    await h.writePreferences(stored({ disabledTools: ['fs.write'], enabledTools: [] }));
    await h.writeConfig([stdioServer('fs')]);

    await h.authority.start();

    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': false });
  });

  it('leaves every tool enabled when the file is absent', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);

    await h.authority.start();

    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': true });
    await expect(h.authority.toolStats()).resolves.toEqual({
      disabled: 0,
      enabled: 2,
      servers: 1,
      total: 2,
    });
  });

  it('persists a toggle before announcing it, stamped with the version this build writes', async () => {
    const h = await setup();
    await h.writePreferences({ ...stored({ disabledTools: [], enabledTools: [] }), version: 1 });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const before = h.toolsEvents().length;

    await h.authority.setToolsEnabled({ enabled: false, toolIds: ['fs.read'] });

    expect(await h.readPreferences()).toMatchObject({
      disabledTools: ['fs.read'],
      enabledTools: ['fs.write'],
      version: 1,
    });
    expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': true });
    expect(h.toolsEvents().length).toBe(before + 1);
  });

  it('toggles a whole server', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await h.authority.setServerToolsEnabled({ enabled: false, serverName: 'fs' });

    expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': false });
    expect(await h.readPreferences()).toMatchObject({
      disabledTools: ['fs.read', 'fs.write'],
      enabledTools: [],
    });
  });

  it('keeps the saved choices of a configured server whose discovery failed', async () => {
    const h = await setup(async (serverId) => {
      if (serverId === parseConfiguredMcpServerId('git')) {
        throw new Error('spawn failed');
      }
      return toolList('read');
    });
    await h.writePreferences(stored({ disabledTools: ['git.push'], enabledTools: [] }));
    await h.writeConfig([stdioServer('fs'), stdioServer('git')]);
    await h.authority.start();

    await h.authority.setToolsEnabled({ enabled: false, toolIds: ['fs.read'] });

    expect(await h.readPreferences()).toMatchObject({
      disabledTools: expect.arrayContaining(['git.push', 'fs.read']),
    });
  });

  it('retires saved choices only for a server removed from the config', async () => {
    const h = await setup();
    await h.writePreferences(
      stored({ disabledTools: ['fs.write', 'old.tool'], enabledTools: ['fs.read'] })
    );
    await h.writeConfig([stdioServer('fs')]);

    await h.authority.start();

    expect(await h.readPreferences()).toMatchObject({
      disabledTools: ['fs.write'],
      enabledTools: ['fs.read'],
    });
  });

  it.each([
    ['invalid', '{ not json'],
    ['invalid', JSON.stringify({ enabledTools: 'all' })],
  ])(
    'fails closed on an %s file: every tool disabled, fault reported, toggles refused',
    async (kind, content) => {
      const h = await setup();
      await h.writePreferences(content);
      await h.writeConfig([stdioServer('fs')]);

      await h.authority.start();

      expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': false });
      const stats = await h.authority.toolStats();
      expect(stats.preferencesFault).toMatchObject({ kind, path: h.preferencesPath });
      await expect(
        h.authority.setToolsEnabled({ enabled: true, toolIds: ['fs.read'] })
      ).rejects.toThrow(/MCP tool preferences could not be loaded/u);
      expect(await readFile(h.preferencesPath, 'utf8')).toBe(content);
      expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': false });
    }
  );

  it('fails closed on an unreadable file', async () => {
    const h = await setup();
    // A directory where the file belongs: the read itself fails.
    await mkdir(h.preferencesPath, { recursive: true });
    await h.writeConfig([stdioServer('fs')]);

    await h.authority.start();

    expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': false });
    await expect(h.authority.toolStats()).resolves.toMatchObject({
      preferencesFault: expect.objectContaining({ kind: 'unreadable' }),
    });
  });

  it('keeps a latched fault when a later config load discovers no tools', async () => {
    const h = await setup();
    await h.writePreferences('{ not json');
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await h.writeConfig([]);
    await h.fireWatch();

    await expect(h.authority.toolStats()).resolves.toMatchObject({
      preferencesFault: expect.objectContaining({ kind: 'invalid' }),
    });
  });

  it('lets reset discard a corrupt file, clear the fault and reopen toggles', async () => {
    const h = await setup();
    await h.writePreferences('{ not json');
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await h.authority.resetTools();

    expect(await h.readPreferences()).toMatchObject({ disabledTools: [], version: 1 });
    expect((await h.authority.toolStats()).preferencesFault).toBeUndefined();
    await h.authority.setToolsEnabled({ enabled: false, toolIds: ['fs.read'] });
    expect(enabledById()).toMatchObject({ 'fs.read': false });
  });

  it('reloads repaired choices without rewriting the file', async () => {
    const h = await setup();
    await h.writePreferences('{ not json');
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    const repaired = JSON.stringify(stored({ disabledTools: ['fs.write'], enabledTools: [] }));
    await writeFile(h.preferencesPath, repaired, 'utf8');

    await h.authority.reloadToolPreferences();

    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': false });
    expect((await h.authority.toolStats()).preferencesFault).toBeUndefined();
    expect(await readFile(h.preferencesPath, 'utf8')).toBe(repaired);
  });

  it('keeps a choice listed as both enabled and disabled disabled on reload', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.writePreferences(stored({ disabledTools: ['fs.read'], enabledTools: ['fs.read'] }));

    await h.authority.reloadToolPreferences();

    expect(enabledById()).toMatchObject({ 'fs.read': false });
  });

  it('fails closed when an explicit reload finds a newly broken file', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.writePreferences('{ broken');

    await expect(h.authority.reloadToolPreferences()).rejects.toThrow(
      /MCP tool preferences could not be loaded/u
    );

    expect(enabledById()).toEqual({ 'fs.read': false, 'fs.write': false });
  });
});

describe('MCP settings factory reset', () => {
  it('empties the runtime, restores the shipped dials and purges the registry', async () => {
    const h = await setup();
    await h.writeStoredExtensions({ v1: { apps: false, tasks: false } });
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();

    await h.authority.reset();

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
    expect(h.settings.values.has('mcp.extensionPreferences')).toBe(false);
    expect(h.setMcpExtensionPreferences).toHaveBeenLastCalledWith({ apps: true, tasks: true });
    expect(enabledById()).toEqual({});
    expect(h.events.at(-1)).toEqual({
      extensions: { apps: true, tasks: true },
      type: 'extensions',
    });
    await expect(h.authority.configStatus()).rejects.toThrow(
      'MCP settings lifecycle is closed for cleanup'
    );
  });

  it('reopens with one live watcher after a successful reset', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.authority.reset();

    await h.authority.resume('succeeded');

    expect(h.activeWatcher()).toBeDefined();
    await expect(h.authority.configStatus()).resolves.toMatchObject({ exists: true });
  });

  it('restores the config, dials, tools and fault when the reset failed', async () => {
    const h = await setup();
    await h.writeStoredExtensions({ v1: { apps: false, tasks: true } });
    await h.writePreferences(stored({ disabledTools: ['fs.write'], enabledTools: [] }));
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.authority.reset();

    await h.authority.resume('failed');

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'fs' })],
    });
    expect(h.setMcpExtensionPreferences).toHaveBeenLastCalledWith({ apps: false, tasks: true });
    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': false });
    expect(h.events.slice(-2).map(({ type }) => type)).toEqual(['config', 'tools']);
  });

  it('keeps refusing toggles over an unreadable file across an abandoned reset', async () => {
    const h = await setup();
    await h.writePreferences('{ not json');
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.authority.reset();

    await h.authority.resume('failed');

    await expect(
      h.authority.setToolsEnabled({ enabled: true, toolIds: ['fs.read'] })
    ).rejects.toThrow(/MCP tool preferences could not be loaded/u);
  });

  it('preserves the original snapshot across a retried reset', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    await h.authority.start();
    await h.authority.reset();
    await h.authority.reset();

    await h.authority.resume('failed');

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'fs' })],
    });
    expect(enabledById()).toEqual({ 'fs.read': true, 'fs.write': true });
  });

  it('refuses to restore after a failed reset when no snapshot exists', async () => {
    const h = await setup();
    await h.authority.start();
    await h.authority.close();

    await expect(h.authority.resume('failed')).rejects.toThrow(
      'Cannot restore MCP settings after a failed reset without a snapshot'
    );
  });
});
