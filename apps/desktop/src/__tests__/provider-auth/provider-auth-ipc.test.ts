import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ProviderAuthEngine } from '../../provider-auth/provider-auth-engine';
import { makeFakeSecrets } from './fake-secrets';

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

const ACCESS_SENTINEL = 'ACCESS-TOKEN-SENTINEL-8f3a';
const REFRESH_SENTINEL = 'REFRESH-TOKEN-SENTINEL-2c9d';
const PROVIDER = 'fake-provider';

function createInvokeEvent(senderId = 4242): IpcMainInvokeEvent {
  return { sender: { id: senderId } } as IpcMainInvokeEvent;
}

async function bootstrap(engineOverrides: Partial<ProviderAuthEngine> = {}) {
  vi.resetModules();
  const { createProviderAuthEngine } = await import('../../provider-auth/provider-auth-engine');
  const { registerProviderAuthIpcHandlers } = await import('../../ipc-domains/provider-auth');
  const { ipcMain } = await import('electron');

  const secrets = makeFakeSecrets({
    [PROVIDER]: {
      access: ACCESS_SENTINEL,
      accountId: 'acct-77',
      expires: Date.now() + 3_600_000,
      refresh: REFRESH_SENTINEL,
      type: 'oauth',
    },
  });
  const engine: ProviderAuthEngine = {
    ...createProviderAuthEngine({
      getDescriptor: () => {
        throw new Error('descriptor lookup unused in this test');
      },
      openExternal: async () => undefined,
      secrets,
    }),
    ...engineOverrides,
  };

  const unregister = registerProviderAuthIpcHandlers({ engine });

  const handleMock = ipcMain.handle as unknown as Mock<
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
  >;
  const getHandler = (channel: string) => {
    const entry = handleMock.mock.calls.find(([name]) => name === channel);
    const handler = entry?.[1];
    if (!handler) {
      throw new Error(`channel not registered: ${channel}`);
    }
    return handler;
  };

  return { engine, getHandler, handleMock, secrets, unregister };
}

const ALL_CHANNELS = [
  'provider-auth:start',
  'provider-auth:cancel',
  'provider-auth:status',
  'provider-auth:disconnect',
] as const;

describe('provider-auth IPC domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');
  });

  it('registers exactly the four provider-auth channels', async () => {
    const { handleMock } = await bootstrap();
    const registered = handleMock.mock.calls.map(([channel]) => channel).sort();
    expect(registered).toEqual([...ALL_CHANNELS].sort());
  });

  it('allows the visible-ui role on every channel', async () => {
    const { getHandler } = await bootstrap();
    for (const channel of ALL_CHANNELS) {
      const result = await getHandler(channel)(createInvokeEvent(), PROVIDER);
      expect(result).toHaveProperty('state');
    }
  });

  it('rejects every hidden-host role and untracked senders on every channel (interactive-desktop pin)', async () => {
    const { getHandler } = await bootstrap();
    for (const role of ['llm-host', 'embedding-host', 'chunking-host', undefined]) {
      getWindowRoleByWebContentsIdMock.mockReturnValue(role);
      for (const channel of ALL_CHANNELS) {
        await expect(getHandler(channel)(createInvokeEvent(), PROVIDER)).rejects.toThrow(
          /visible-ui/
        );
      }
    }
  });

  it('returns the token-free connected status for a stored oauth credential', async () => {
    const { getHandler } = await bootstrap();
    const status = await getHandler('provider-auth:status')(createInvokeEvent(), PROVIDER);
    expect(status).toEqual({ accountId: 'acct-77', state: 'connected' });
  });

  it('NEVER leaks token material through any status payload (gate constraint 3)', async () => {
    const { getHandler } = await bootstrap();
    const payloads: unknown[] = [];

    payloads.push(await getHandler('provider-auth:status')(createInvokeEvent(), PROVIDER));
    // Unknown provider start -> error status.
    payloads.push(await getHandler('provider-auth:start')(createInvokeEvent(), PROVIDER));
    payloads.push(await getHandler('provider-auth:cancel')(createInvokeEvent(), PROVIDER));
    // Disconnect LAST: deletes the credential and reports disconnected.
    payloads.push(await getHandler('provider-auth:disconnect')(createInvokeEvent(), PROVIDER));

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect(serialized).not.toContain(REFRESH_SENTINEL);
    expect(serialized.toLowerCase()).not.toContain('access_token');
    expect(serialized.toLowerCase()).not.toContain('refresh_token');
  });

  it('disconnect deletes the stored credential', async () => {
    const { getHandler, secrets } = await bootstrap();
    const status = await getHandler('provider-auth:disconnect')(createInvokeEvent(), PROVIDER);
    expect(status).toEqual({ state: 'disconnected' });
    expect(secrets.store.has(PROVIDER)).toBe(false);
  });

  it('rejects malformed provider ids instead of coercing them', async () => {
    const { getHandler } = await bootstrap();
    for (const bad of ['', 42, null, undefined, {}]) {
      await expect(getHandler('provider-auth:status')(createInvokeEvent(), bad)).rejects.toThrow(
        /provider/i
      );
    }
  });

  it('rejects malformed start methods instead of coercing them', async () => {
    const { getHandler } = await bootstrap();
    await expect(
      getHandler('provider-auth:start')(createInvokeEvent(), PROVIDER, 'webview')
    ).rejects.toThrow(/method/i);
  });

  it('unregisters all channels on teardown', async () => {
    const { unregister } = await bootstrap();
    const { ipcMain } = await import('electron');
    unregister();
    const removed = (ipcMain.removeHandler as unknown as Mock).mock.calls.map(
      ([channel]) => channel
    );
    expect(removed.sort()).toEqual([...ALL_CHANNELS].sort());
  });
});
