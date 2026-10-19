import { readFile } from 'node:fs/promises';
import type { McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpConfigRevision } from '../src/mcp/config-file.js';
import {
  createSettingsHarness,
  type SettingsHarness,
  stdioServer,
  toolList,
} from './mcp-settings-authority-harness.js';

const EMPTY_REVISION = mcpConfigRevision('');
const WATCH_FAILURE = 'EMFILE: too many open files, watch';
const RUNTIME_FAILURE = 'EPERM: operation not permitted, watch';
const CLOSE_FAILURE = 'the config watcher handle could not be closed';
const RELOAD_FAILURE = 'runtime refused the config';
const RELOAD_AFTER_RESTART_FAILURE = `the MCP config could not be reloaded after its watcher restarted: ${RELOAD_FAILURE}`;

let harness: SettingsHarness | undefined;
async function setup(): Promise<SettingsHarness> {
  harness = await createSettingsHarness({ listTools: async () => toolList('read') });
  return harness;
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

function configEvents(h: SettingsHarness): Extract<McpSettingsEvent, { type: 'config' }>[] {
  return h.events.filter(
    (event): event is Extract<McpSettingsEvent, { type: 'config' }> => event.type === 'config'
  );
}

function failNextWatch(h: SettingsHarness): void {
  vi.mocked(h.configFile.watch).mockRejectedValueOnce(new Error(WATCH_FAILURE));
}

/** Starts the authority on one server, then its running watcher dies. */
async function watcherDiedWhileRunning(h: SettingsHarness): Promise<void> {
  await h.writeConfig([stdioServer('fs')]);
  await h.authority.start();
  h.failWatch(new Error(RUNTIME_FAILURE));
}

/** The live watcher's next close throws. */
function failNextClose(h: SettingsHarness): void {
  const watcher = h.activeWatcher();
  if (!watcher) {
    throw new Error('No live MCP config watcher');
  }
  watcher.close.mockImplementationOnce(() => {
    throw new Error(CLOSE_FAILURE);
  });
}

/** Starts the authority, then saves one server while the watcher cannot restart. */
async function savedWithoutWatcher(h: SettingsHarness) {
  await h.authority.start();
  failNextWatch(h);
  return await h.authority.writeConfigText({
    baseRevision: EMPTY_REVISION,
    content: JSON.stringify({ servers: [stdioServer('fs')] }),
  });
}

describe('MCP settings authority config watcher health', () => {
  it('keeps a save that the watcher cannot follow, reloads it, and reports watchError', async () => {
    const h = await setup();

    const result = await savedWithoutWatcher(h);

    const written = await readFile(h.configPath, 'utf8');
    expect(result).toEqual({
      path: h.configPath,
      revision: mcpConfigRevision(written),
      success: true,
    });
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'fs' })],
    });
    expect(configEvents(h).at(-1)).toEqual({
      config: expect.objectContaining({
        servers: [{ name: 'fs', protocol: 'legacy', transport: 'stdio' }],
        watchError: WATCH_FAILURE,
      }),
      type: 'config',
    });
    expect(h.activeWatcher()).toBeUndefined();
    await expect(h.authority.configStatus()).resolves.toMatchObject({ watchError: WATCH_FAILURE });
  });

  it('restarts the watcher on the next save and clears watchError', async () => {
    const h = await setup();
    const first = await savedWithoutWatcher(h);
    if (!first.success) {
      throw new Error(first.error);
    }

    await expect(
      h.authority.writeConfigText({
        baseRevision: first.revision,
        content: JSON.stringify({ servers: [stdioServer('fs'), stdioServer('git')] }),
      })
    ).resolves.toMatchObject({ success: true });

    expect(h.activeWatcher()).toBeDefined();
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('restarts the watcher when the editor reads the config, reloading and announcing only then', async () => {
    const h = await setup();
    await savedWithoutWatcher(h);
    const before = configEvents(h).length;

    failNextWatch(h);
    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });
    expect(configEvents(h)).toHaveLength(before);
    expect(h.activeWatcher()).toBeUndefined();

    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });
    expect(h.activeWatcher()).toBeDefined();
    // The cleared watchError, then the reload of what the watcher missed.
    expect(configEvents(h)).toHaveLength(before + 2);
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');

    const watches = vi.mocked(h.configFile.watch).mock.calls.length;
    const reloads = h.replaceResolvedConfig.mock.calls.length;
    await h.authority.readConfigText();
    expect(h.configFile.watch).toHaveBeenCalledTimes(watches);
    expect(h.replaceResolvedConfig).toHaveBeenCalledTimes(reloads);
    expect(configEvents(h)).toHaveLength(before + 2);
  });

  it('starts without a watcher, loading the config and reporting watchError', async () => {
    const h = await setup();
    await h.writeConfig([stdioServer('fs')]);
    failNextWatch(h);

    await expect(h.authority.start()).resolves.toBeUndefined();

    expect(h.replaceResolvedConfig).toHaveBeenCalledWith({
      servers: [expect.objectContaining({ name: 'fs' })],
    });
    expect(configEvents(h)).toEqual([
      {
        config: expect.objectContaining({ exists: true, watchError: WATCH_FAILURE }),
        type: 'config',
      },
    ]);
  });

  it('restarts the watcher after a write that threw', async () => {
    const h = await setup();
    await h.authority.start();
    vi.spyOn(h.configFile, 'writeText').mockRejectedValueOnce(new Error('EACCES'));

    await expect(
      h.authority.writeConfigText({ baseRevision: EMPTY_REVISION, content: '{"servers":[]}' })
    ).rejects.toThrow('EACCES');

    expect(h.activeWatcher()).toBeDefined();
  });

  it('never retries the watcher once closed, even for a write closing interrupted', async () => {
    const h = await setup();
    await h.authority.start();
    const writeText = h.configFile.writeText;
    const held = Promise.withResolvers<void>();
    vi.spyOn(h.configFile, 'writeText').mockImplementationOnce(async (content, baseRevision) => {
      await held.promise;
      return await writeText(content, baseRevision);
    });
    const save = h.authority.writeConfigText({
      baseRevision: EMPTY_REVISION,
      content: JSON.stringify({ servers: [stdioServer('fs')] }),
    });
    await vi.waitFor(() => expect(h.configFile.writeText).toHaveBeenCalled());
    const watches = vi.mocked(h.configFile.watch).mock.calls.length;

    const closed = h.authority.close();
    held.resolve();
    await expect(save).resolves.toMatchObject({ success: true });
    await closed;

    const refused = { failure: { code: 'mcp.settings-closed', kind: 'refusal' } };
    await expect(h.authority.readConfigText()).rejects.toMatchObject(refused);
    await expect(
      h.authority.writeConfigText({ baseRevision: EMPTY_REVISION, content: '{"servers":[]}' })
    ).rejects.toMatchObject(refused);
    expect(h.configFile.watch).toHaveBeenCalledTimes(watches);
    expect(h.activeWatcher()).toBeUndefined();
  });

  it('never wants a watcher for a path change that closing interrupted', async () => {
    const h = await setup();
    await h.authority.start();
    const load = h.configFile.load;
    const held = Promise.withResolvers<void>();
    vi.spyOn(h.configFile, 'load').mockImplementationOnce(async () => {
      await held.promise;
      return await load();
    });
    const pathChange = h.authority.setConfigPath({ path: null });
    await vi.waitFor(() => expect(h.configFile.load).toHaveBeenCalled());
    const watches = vi.mocked(h.configFile.watch).mock.calls.length;

    const closed = h.authority.close();
    held.resolve();
    await pathChange;
    await closed;

    expect(h.configFile.watch).toHaveBeenCalledTimes(watches);
  });

  it('clears watchError across a reset, and the resumed watcher restarts after saves', async () => {
    const h = await setup();
    await savedWithoutWatcher(h);
    await h.authority.reset();

    await h.authority.resume('succeeded');

    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
    const { revision } = await h.authority.readConfigText();
    await h.authority.writeConfigText({ baseRevision: revision, content: '{"servers":[]}' });
    expect(h.activeWatcher()).toBeDefined();
  });

  it('drops a watcher failure that a reset retired before it settled', async () => {
    const h = await setup();
    await h.authority.start();
    const watch = Promise.withResolvers<never>();
    vi.mocked(h.configFile.watch).mockImplementationOnce(async () => await watch.promise);
    const save = h.authority.writeConfigText({
      baseRevision: EMPTY_REVISION,
      content: JSON.stringify({ servers: [stdioServer('fs')] }),
    });
    await vi.waitFor(() => expect(h.configFile.watch).toHaveBeenCalledTimes(2));

    const reset = h.authority.reset();
    watch.reject(new Error(WATCH_FAILURE));
    await save;
    await reset;
    await h.authority.resume('failed');

    expect(configEvents(h).some(({ config }) => config.watchError !== undefined)).toBe(false);
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });
});

describe('MCP settings authority config watcher that fails while held', () => {
  it('reports watchError when the running watcher dies, and the next save restarts it', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);

    expect(h.activeWatcher()).toBeUndefined();
    expect(configEvents(h).at(-1)).toEqual({
      config: expect.objectContaining({ exists: true, watchError: RUNTIME_FAILURE }),
      type: 'config',
    });
    await expect(h.authority.configStatus()).resolves.toMatchObject({
      watchError: RUNTIME_FAILURE,
    });

    const revision = mcpConfigRevision(await readFile(h.configPath, 'utf8'));
    await expect(
      h.authority.writeConfigText({
        baseRevision: revision,
        content: JSON.stringify({ servers: [stdioServer('git')] }),
      })
    ).resolves.toMatchObject({ success: true });

    expect(h.activeWatcher()).toBeDefined();
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('restarts a watcher that died while running when the editor reads the config', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);

    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });

    expect(h.activeWatcher()).toBeDefined();
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('applies an edit made while the watcher was down when a config read restarts it', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    await h.writeConfig([stdioServer('external')]);

    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'external' })],
    });
    expect(configEvents(h).at(-1)?.config).toMatchObject({
      servers: [{ name: 'external', protocol: 'legacy', transport: 'stdio' }],
    });
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
  });

  it('applies an edit made while the watcher was down when a failed save restarts it', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    await h.writeConfig([stdioServer('external')]);
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });

    await expect(
      h.authority.writeConfigText({ baseRevision: EMPTY_REVISION, content: '{"servers":[]}' })
    ).resolves.toEqual({ error: 'disk full', path: h.configPath, success: false });

    expect(h.activeWatcher()).toBeDefined();
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'external' })],
    });
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
  });

  it('puts a restarted watcher back down when it cannot reload what it missed, and rejects the read', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    const reloadFailure = new Error(RELOAD_FAILURE);
    h.replaceResolvedConfig.mockRejectedValueOnce(reloadFailure);

    await expect(h.authority.readConfigText()).rejects.toBe(reloadFailure);

    expect(h.activeWatcher()).toBeUndefined();
    expect(configEvents(h).at(-1)?.config).toMatchObject({
      watchError: RELOAD_AFTER_RESTART_FAILURE,
    });
    await expect(h.authority.configStatus()).resolves.toMatchObject({
      watchError: RELOAD_AFTER_RESTART_FAILURE,
    });
  });

  it('retries a failed recovery reload on the next config read, applying the missed edit', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    h.replaceResolvedConfig.mockRejectedValueOnce(new Error(RELOAD_FAILURE));
    await expect(h.authority.readConfigText()).rejects.toThrow(RELOAD_FAILURE);
    await h.writeConfig([stdioServer('external')]);

    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });

    expect(h.activeWatcher()).toBeDefined();
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'external' })],
    });
    expect(configEvents(h).at(-1)?.config).not.toHaveProperty('watchError');
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('puts a watcher a successful save restarted back down when its reload fails, and a read retries', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    const revision = mcpConfigRevision(await readFile(h.configPath, 'utf8'));
    const reloadFailure = new Error(RELOAD_FAILURE);
    h.replaceResolvedConfig.mockRejectedValueOnce(reloadFailure);

    await expect(
      h.authority.writeConfigText({
        baseRevision: revision,
        content: JSON.stringify({ servers: [stdioServer('git')] }),
      })
    ).rejects.toBe(reloadFailure);

    expect(h.activeWatcher()).toBeUndefined();
    expect(configEvents(h).at(-1)?.config).toMatchObject({
      watchError: RELOAD_AFTER_RESTART_FAILURE,
    });
    await expect(h.authority.configStatus()).resolves.toMatchObject({
      watchError: RELOAD_AFTER_RESTART_FAILURE,
    });

    await expect(h.authority.readConfigText()).resolves.toMatchObject({ exists: true });
    expect(h.activeWatcher()).toBeDefined();
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'git' })],
    });
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('puts a watcher a failed save restarted back down when it cannot reload what it missed', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });
    h.replaceResolvedConfig.mockRejectedValueOnce(new Error(RELOAD_FAILURE));

    await expect(
      h.authority.writeConfigText({ baseRevision: EMPTY_REVISION, content: '{"servers":[]}' })
    ).rejects.toMatchObject({
      message: `disk full; the MCP config could not be reloaded: ${RELOAD_FAILURE}`,
    });

    expect(h.activeWatcher()).toBeUndefined();
    await expect(h.authority.configStatus()).resolves.toMatchObject({
      watchError: RELOAD_AFTER_RESTART_FAILURE,
    });
  });

  it('drops a recovery reload failure that a reset retired before it settled', async () => {
    const h = await setup();
    await watcherDiedWhileRunning(h);
    const reload = Promise.withResolvers<never>();
    const calls = h.replaceResolvedConfig.mock.calls.length;
    h.replaceResolvedConfig.mockImplementationOnce(async () => await reload.promise);
    const read = h.authority.readConfigText();
    await vi.waitFor(() => expect(h.replaceResolvedConfig).toHaveBeenCalledTimes(calls + 1));

    const reset = h.authority.reset();
    reload.reject(new Error(RELOAD_FAILURE));
    await expect(read).rejects.toThrow(RELOAD_FAILURE);
    await reset;
    await h.authority.resume('failed');

    expect(
      configEvents(h).some(({ config }) => config.watchError === RELOAD_AFTER_RESTART_FAILURE)
    ).toBe(false);
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('ignores a failure from the watcher of a retired lifecycle', async () => {
    const h = await setup();
    await h.authority.start();
    const retired = h.activeWatcher();
    expect(retired).toBeDefined();
    await h.authority.reset();
    await h.authority.resume('succeeded');

    h.failWatch(new Error(RUNTIME_FAILURE), retired);

    expect(configEvents(h).some(({ config }) => config.watchError !== undefined)).toBe(false);
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('keeps a save whose watcher cannot be stopped, reporting watchError until a read restarts it', async () => {
    const h = await setup();
    await h.authority.start();
    failNextClose(h);

    await expect(
      h.authority.writeConfigText({
        baseRevision: EMPTY_REVISION,
        content: JSON.stringify({ servers: [stdioServer('fs')] }),
      })
    ).resolves.toMatchObject({ success: true });

    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'fs' })],
    });
    expect(h.activeWatcher()).toBeUndefined();
    expect(configEvents(h).at(-1)?.config).toMatchObject({ watchError: CLOSE_FAILURE });
    await expect(h.authority.configStatus()).resolves.toMatchObject({ watchError: CLOSE_FAILURE });

    await h.authority.readConfigText();
    expect(h.activeWatcher()).toBeDefined();
    await expect(h.authority.configStatus()).resolves.not.toHaveProperty('watchError');
  });

  it('keeps a path change whose watcher cannot be stopped, and reports watchError', async () => {
    const h = await setup();
    await h.authority.start();
    failNextClose(h);

    await expect(h.authority.setConfigPath({ path: null })).resolves.toEqual({
      path: h.configPath,
      success: true,
    });

    expect(h.activeWatcher()).toBeUndefined();
    expect(configEvents(h).at(-1)?.config).toMatchObject({ watchError: CLOSE_FAILURE });
    await expect(h.authority.configStatus()).resolves.toMatchObject({ watchError: CLOSE_FAILURE });
  });
});
