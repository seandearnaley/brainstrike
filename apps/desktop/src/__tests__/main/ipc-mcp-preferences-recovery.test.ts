import path from 'node:path';
import type { ToolPreferences, ToolPreferencesLoadResult } from '@brainstrike/agent';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMcpConfig } from '../../mcp-loader';

const mocks = vi.hoisted(() => ({
  bytes: null as string | null,
  config: null as LoadedMcpConfig | null,
  load: vi.fn<(directory: string) => Promise<ToolPreferencesLoadResult>>(),
  readError: null as Error | null,
  readGate: null as Promise<void> | null,
  save: vi.fn<(directory: string, preferences: ToolPreferences) => Promise<void>>(),
  watch: null as ((config: LoadedMcpConfig) => Promise<void> | void) | null,
}));

vi.mock('@brainstrike/agent', async () => {
  // @boundaries-ignore Exercise the real registry without loading the unrelated Mastra runtime barrel.
  const { ToolRegistry } = await import('../../../../../packages/agent/src/mcp/tool-registry');
  // @boundaries-ignore Real persistence parser/writer prove byte retention behind an injected filesystem.
  const { loadToolPreferences, saveToolPreferences } = await import(
    '../../../../../packages/agent/src/mcp/tool-persistence'
  );
  const fs = {
    dirname: path.dirname,
    join: path.join,
    mkdir: async () => undefined,
    readFile: async () => {
      const bytes = mocks.bytes;
      const error = mocks.readError;
      await mocks.readGate;
      if (error) {
        throw error;
      }
      if (bytes === null) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return bytes;
    },
    unlink: async () => {
      mocks.bytes = null;
    },
    writeFile: async (_file: string, bytes: string) => {
      mocks.bytes = bytes;
    },
  };
  mocks.load.mockImplementation((directory) => loadToolPreferences(directory, fs));
  mocks.save.mockImplementation((directory, preferences) =>
    saveToolPreferences(directory, preferences, fs)
  );
  return {
    loadToolPreferences: mocks.load,
    mcpToolRegistry: new ToolRegistry(),
    saveToolPreferences: mocks.save,
  };
});
vi.mock('electron', async () => {
  const { electronMainMock } = await import('../helpers/electron-main-test-harness');
  return electronMainMock;
});
vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: () => '{}',
  getMcpConfigPath: async () => '/profile/mcp/config.json',
  loadMcpConfig: async () => mocks.config,
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: async (callback: typeof mocks.watch) => {
    mocks.watch = callback;
    return { close: vi.fn() };
  },
  writeMcpConfigText: vi.fn(),
}));
vi.mock('../../window-role', () => ({
  getTrackedWindowsByRole: () => [],
  getWindowRoleByWebContentsId: (id: number) => (id === 1 ? 'visible-ui' : 'embedding-host'),
}));

import { mcpToolRegistry } from '@brainstrike/agent';
import {
  registerMcpIpcHandlers,
  resetMcpRuntimeForFactoryReset,
  resumeMcpRuntimeAfterFactoryReset,
} from '../../ipc-mcp';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import {
  createRecordingWindow,
  electronMainMock,
  getRegisteredIpcMainHandler,
  resetElectronMainTestHarness,
} from '../helpers/electron-main-test-harness';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

const authority = createMcpAuthorityTestRuntime(async () => ({
  tools: ['read', 'write', 'default', 'filtered'].map((name) => ({
    inputSchema: { type: 'object' as const },
    name,
  })),
}));
const event = { sender: { id: 1 }, senderFrame: createAllowlistedSenderFrame() };
let detach: (() => void) | undefined;
const rendererWindow = createRecordingWindow();
function toolEvents(): unknown[] {
  return rendererWindow.payloadsFor('mcp:tools:updated');
}
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return await getRegisteredIpcMainHandler(channel)(event, ...args);
}
function preferences(disabledTools: string[] = [], enabledTools: string[] = []): string {
  return `${JSON.stringify({ disabledTools, enabledTools, lastUpdated: 123, version: 9 }, null, 4)}\n`;
}
function states(): Record<string, boolean> {
  return Object.fromEntries(
    Object.values(mcpToolRegistry.getAllTools())
      .flat()
      .map(({ id, enabled }) => [id, enabled])
  );
}
async function start(): Promise<void> {
  detach = registerMcpIpcHandlers({ runtime: authority.runtime });
  await invoke('mcp:status:get');
  rendererWindow.reset();
  mocks.load.mockClear();
  mocks.save.mockClear();
}
const reload = (): Promise<unknown> => invoke('mcp:tools:reloadPreferences');

describe('read-only in-session MCP tool preference recovery', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
    rendererWindow.reset();
    electronMainMock.app.getPath.mockReturnValue('/profile');
    electronMainMock.BrowserWindow.getAllWindows.mockReturnValue([rendererWindow] as never);
    mocks.bytes = '{broken';
    mocks.readError = null;
    mocks.readGate = null;
    mocks.config = {
      config: {
        servers: [
          {
            command: 'mock',
            enabledTools: ['*', '!server.filtered'],
            name: parseConfiguredMcpServerId('server'),
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      },
      exists: true,
      path: '/profile/mcp/config.json',
    };
  });
  afterEach(async () => {
    mocks.readGate = null;
    await resetMcpRuntimeForFactoryReset(authority.runtime);
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime);
    detach?.();
  });

  it('rejects a hidden sender before reading preferences', async () => {
    await start();
    await expect(
      getRegisteredIpcMainHandler('mcp:tools:reloadPreferences')({ ...event, sender: { id: 2 } })
    ).rejects.toThrow('requires sender role visible-ui');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'unreadable'] as const)(
    'recovers %s with repaired choices and untouched bytes before enabling writes',
    async (fault) => {
      if (fault === 'unreadable') {
        mocks.readError = new Error('EACCES');
      }
      await start();
      expect(Object.values(states())).toEqual([false, false, false, false]);
      mocks.readError = null;
      const repaired = preferences(
        ['server.write', 'undiscovered.danger'],
        ['server.read', 'retired.kept']
      );
      mocks.bytes = repaired;
      await reload();
      expect(states()).toEqual({
        'server.default': true,
        'server.filtered': false,
        'server.read': true,
        'server.write': false,
      });
      expect(mocks.bytes).toBe(repaired);
      expect(mocks.save).not.toHaveBeenCalled();
      expect(toolEvents()).toHaveLength(1);
      expect(toolEvents()[0]).toEqual(mcpToolRegistry.getAllTools());
      expect(await invoke('mcp:tools:getStats')).not.toHaveProperty('preferencesFault');
      await invoke('mcp:tools:disable', ['server.read']);
      expect(JSON.parse(mocks.bytes ?? '')).toMatchObject({
        disabledTools: expect.arrayContaining([
          'server.write',
          'server.read',
          'undiscovered.danger',
        ]),
        enabledTools: expect.arrayContaining(['server.default', 'retired.kept']),
      });
    }
  );

  it('restores configured defaults after removing the file without recreating it', async () => {
    await start();
    mocks.bytes = null;
    await reload();
    expect(states()).toEqual({
      'server.default': true,
      'server.filtered': false,
      'server.read': true,
      'server.write': true,
    });
    expect(mocks.bytes).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('keeps overlapping enabled and disabled choices disabled', async () => {
    await start();
    mocks.bytes = preferences(['server.write'], ['server.write']);
    await reload();
    expect(states()['server.write']).toBe(false);
  });

  it.each(['invalid', 'unreadable'] as const)(
    'fails closed for a still %s file and leaves it untouched',
    async (fault) => {
      await start();
      if (fault === 'unreadable') {
        mocks.readError = new Error('EACCES');
      }
      await expect(reload()).rejects.toThrow('Reload tool preferences');
      expect(mocks.bytes).toBe('{broken');
      expect(mocks.save).not.toHaveBeenCalled();
      expect(Object.values(states())).toEqual([false, false, false, false]);
      expect(await invoke('mcp:tools:getStats')).toHaveProperty('preferencesFault.kind', fault);
      await expect(invoke('mcp:tools:enable', ['server.read'])).rejects.toThrow('tool preferences');
    }
  );

  it('reads recovery with zero discovered tools and never retires stored ids', async () => {
    await start();
    await mocks.watch?.({
      config: { servers: [] },
      exists: true,
      path: '/profile/mcp/config.json',
    });
    await expect(reload()).rejects.toThrow('tool preferences');
    const repaired = preferences(['undiscovered.danger'], ['retired.kept']);
    mocks.bytes = repaired;
    await reload();
    expect(states()).toEqual({});
    expect(mocks.bytes).toBe(repaired);
    expect(await invoke('mcp:tools:getStats')).not.toHaveProperty('preferencesFault');
  });

  it('serializes reset behind the recovery read so a stale read cannot undo reset', async () => {
    await start();
    mocks.bytes = preferences(['server.write']);
    const gate = Promise.withResolvers<void>();
    mocks.readGate = gate.promise;
    const recovery = reload();
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const reset = invoke('mcp:tools:reset');
    expect(mocks.save).not.toHaveBeenCalled();
    gate.resolve();
    await recovery;
    await reset;
    expect(Object.values(states())).toEqual([true, true, true, true]);
    expect(JSON.parse(mocks.bytes ?? '')).toHaveProperty('disabledTools', []);
  });

  it('refuses a toggle while recovery is pending and permits retry only after projection', async () => {
    await start();
    mocks.bytes = preferences(['server.write']);
    const gate = Promise.withResolvers<void>();
    mocks.readGate = gate.promise;
    const recovery = reload();
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    await expect(invoke('mcp:tools:enable', ['server.read'])).rejects.toThrow('tool preferences');
    expect(toolEvents()).toHaveLength(0);
    expect(mocks.save).not.toHaveBeenCalled();
    gate.resolve();
    await recovery;
    await invoke('mcp:tools:enable', ['server.read']);
    expect(states()['server.write']).toBe(false);
  });

  it('projects repaired choices before a healthy-session toggle queued behind reload', async () => {
    mocks.bytes = preferences();
    await start();
    mocks.bytes = preferences(['server.write', 'undiscovered.danger']);
    const gate = Promise.withResolvers<void>();
    mocks.readGate = gate.promise;
    const recovery = reload();
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const toggle = invoke('mcp:tools:disable', ['server.read']);
    expect(mocks.save).not.toHaveBeenCalled();
    gate.resolve();
    await recovery;
    await toggle;
    expect(states()['server.write']).toBe(false);
    expect(JSON.parse(mocks.bytes ?? '')).toHaveProperty(
      'disabledTools',
      expect.arrayContaining(['server.write', 'server.read', 'undiscovered.danger'])
    );
  });

  it('retains configured defaults for recovery after an abandoned factory reset', async () => {
    await start();
    await resetMcpRuntimeForFactoryReset(authority.runtime);
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');
    mocks.bytes = null;
    await reload();
    expect(states()).toEqual({
      'server.default': true,
      'server.filtered': false,
      'server.read': true,
      'server.write': true,
    });
    expect(mocks.bytes).toBeNull();
  });

  it('fails closed if an explicit reload finds a newly broken previously healthy file', async () => {
    mocks.bytes = preferences();
    await start();
    mocks.bytes = '{broken';
    await expect(reload()).rejects.toThrow('Reload tool preferences');
    expect(Object.values(states())).toEqual([false, false, false, false]);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(toolEvents()).toHaveLength(1);
    await expect(invoke('mcp:tools:enable', ['server.read'])).rejects.toThrow('tool preferences');
  });

  it('rejects a recovery retired during its read by config replacement', async () => {
    await start();
    mocks.bytes = preferences(['server.write']);
    const gate = Promise.withResolvers<void>();
    mocks.readGate = gate.promise;
    const recovery = reload();
    const rejected = expect(recovery).rejects.toThrow(/changed|retired/);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const change = mocks.watch?.({
      config: { servers: [] },
      exists: true,
      path: '/profile/mcp/config.json',
    });
    gate.resolve();
    await rejected;
    await change;
    expect(states()).toEqual({});
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects a recovery retired during its read by factory reset', async () => {
    await start();
    mocks.bytes = preferences(['server.write']);
    const gate = Promise.withResolvers<void>();
    mocks.readGate = gate.promise;
    const recovery = reload();
    const rejected = expect(recovery).rejects.toThrow(/changed|retired/);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const reset = resetMcpRuntimeForFactoryReset(authority.runtime);
    gate.resolve();
    await rejected;
    await reset;
    expect(states()).toEqual({});
    expect(toolEvents()).toHaveLength(0);
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime);
  });
});
