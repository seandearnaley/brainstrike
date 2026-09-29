/**
 * Global MCP registered-extension dials over IPC (BST-1604): startup reads the
 * stored opt-out before any server connects, a write persists BEFORE it reaches
 * the live host, and factory reset returns the dials to the shipped default.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { MCP_EXTENSION_PREFERENCES_STORE_KEY } from '../../mcp/extension-preferences';
import { loadMcpConfig, watchMcpConfig } from '../../mcp-loader';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(() => 'visible-ui'),
}));

vi.mock('../../window-role', () => ({
  getTrackedWindowsByRole: vi.fn(() => []),
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

type RegisteredHandler = (...args: unknown[]) => Promise<unknown> | unknown;

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{\n  "servers": []\n}'),
  getMcpConfigPath: vi.fn(() => '/tmp/mcp.json'),
  loadMcpConfig: vi.fn(),
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: vi.fn() })),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => ({
    deleteKey: vi.fn(),
    getKey: vi.fn(async () => null),
    listProviders: vi.fn(async () => []),
    saveKey: vi.fn(),
  })),
}));

const authority = createMcpAuthorityTestRuntime();
const VISIBLE_UI_EVENT = { sender: { id: 1 }, senderFrame: createAllowlistedSenderFrame() };

function invokeRegisteredHandler(handler: RegisteredHandler, args: unknown[]): unknown {
  if (args.length >= 2 && typeof args[0] === 'object' && args[0] !== null) {
    return handler(VISIBLE_UI_EVENT, ...args.slice(1));
  }
  return handler(VISIBLE_UI_EVENT, ...args);
}

function createSettingsStore(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set(MCP_EXTENSION_PREFERENCES_STORE_KEY, initial);
  }
  return {
    access: () => ({
      delete: (key: string) => {
        values.delete(key);
      },
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => {
        values.set(key, value);
      },
    }),
    values,
  };
}

async function register(stored?: unknown) {
  const handlers = new Map<string, RegisteredHandler>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers.set(channel, (...args) => invokeRegisteredHandler(handler as RegisteredHandler, args));
  });
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    },
  ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
  const settings = createSettingsStore(stored);
  const unregister = mcpIpc.registerMcpIpcHandlers({
    runtime: authority.runtime,
    settingsStore: settings.access,
  });
  await handlers.get('mcp:status:get')?.();
  return { handlers, sent, settings, unregister };
}

describe('MCP registered-extension dials over IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadMcpConfig).mockResolvedValue({
      config: { servers: [] },
      exists: true,
      path: '/tmp/mcp.json',
    } as never);
    vi.mocked(watchMcpConfig).mockResolvedValue({ close: vi.fn() });
  });

  it('applies the shipped default when nothing is stored', async () => {
    const { handlers } = await register();
    await expect(handlers.get('mcp:extensions:get')?.()).resolves.toEqual({
      apps: true,
      tasks: true,
    });
    expect(authority.setMcpExtensionPreferences).toHaveBeenCalledWith({ apps: true, tasks: true });
  });

  it('applies a stored opt-out at startup, before any server is configured', async () => {
    await register({ v1: { apps: false, tasks: true } });
    expect(authority.setMcpExtensionPreferences).toHaveBeenCalledWith({ apps: false, tasks: true });
    // The dials are set before the config load hands servers to the authority.
    const dialCall = authority.setMcpExtensionPreferences.mock.invocationCallOrder[0] ?? 0;
    const configCall = authority.replaceResolvedConfig.mock.invocationCallOrder[0] ?? 0;
    expect(dialCall).toBeLessThan(configCall);
  });

  it('fails closed when the stored preference cannot be read', async () => {
    await register({ v1: { apps: 'yes' } });
    expect(authority.setMcpExtensionPreferences).toHaveBeenCalledWith({
      apps: false,
      tasks: false,
    });
  });

  it('persists, applies and broadcasts a write', async () => {
    const { handlers, sent, settings } = await register();
    await expect(handlers.get('mcp:extensions:set')?.({}, { tasks: false })).resolves.toEqual({
      apps: true,
      tasks: false,
    });
    expect(settings.values.get(MCP_EXTENSION_PREFERENCES_STORE_KEY)).toEqual({
      v1: { apps: true, tasks: false },
    });
    expect(authority.setMcpExtensionPreferences).toHaveBeenLastCalledWith({
      apps: true,
      tasks: false,
    });
    expect(sent).toContainEqual({
      channel: 'mcp:extensions:updated',
      payload: { apps: true, tasks: false },
    });
  });

  it('rejects a malformed write without persisting or touching the live host', async () => {
    const { handlers, sent, settings } = await register();
    const appliedBefore = authority.setMcpExtensionPreferences.mock.calls.length;
    await expect(handlers.get('mcp:extensions:set')?.({}, { apps: 'off' })).rejects.toThrow();
    expect(settings.values.has(MCP_EXTENSION_PREFERENCES_STORE_KEY)).toBe(false);
    expect(authority.setMcpExtensionPreferences).toHaveBeenCalledTimes(appliedBefore);
    expect(sent.filter(({ channel }) => channel === 'mcp:extensions:updated')).toEqual([]);
  });

  it('returns the dials to the shipped default across a factory reset', async () => {
    const { settings } = await register({ v1: { apps: false, tasks: false } });
    expect(authority.setMcpExtensionPreferences).toHaveBeenLastCalledWith({
      apps: false,
      tasks: false,
    });
    await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
    expect(settings.values.has(MCP_EXTENSION_PREFERENCES_STORE_KEY)).toBe(false);
    expect(authority.setMcpExtensionPreferences).toHaveBeenLastCalledWith({
      apps: true,
      tasks: true,
    });
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime);
  });

  it('restores the captured dials when a factory reset fails', async () => {
    await register({ v1: { apps: false, tasks: true } });
    await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');
    expect(authority.setMcpExtensionPreferences).toHaveBeenLastCalledWith({
      apps: false,
      tasks: true,
    });
  });
});
