import type { ProviderAuthStatus } from '@brainstrike/assistant-contract';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { DesktopProviderAuth } from '../../ipc-domains/provider-auth';
import {
  createAllowlistedSenderFrame,
  reconfigureTestRendererTargetAfterModuleReset,
} from '../helpers/desktop-ipc-sender-frame-test-allowlist';

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

const PROVIDER = 'openai-codex';

function createInvokeEvent(senderId = 4242): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

/** The host's answers as Main's private client returns them. */
function createHostAuth(): { [K in keyof DesktopProviderAuth]: Mock<DesktopProviderAuth[K]> } {
  const connected: ProviderAuthStatus = { accountId: 'acct-77', state: 'connected' };
  return {
    cancel: vi.fn(async () => connected),
    connect: vi.fn(async () => ({ state: 'awaiting_browser' }) as const),
    disconnect: vi.fn(async () => ({ state: 'disconnected' }) as const),
    status: vi.fn(async () => connected),
  };
}

async function bootstrap() {
  vi.resetModules();
  await reconfigureTestRendererTargetAfterModuleReset();
  const { registerProviderAuthIpcHandlers } = await import('../../ipc-domains/provider-auth');
  const { ipcMain } = await import('electron');
  const auth = createHostAuth();
  const unregister = registerProviderAuthIpcHandlers({ auth });
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
  return { auth, getHandler, handleMock, unregister };
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

  it('forwards each visible-ui call to the host sign-in engine and returns its status', async () => {
    const { auth, getHandler } = await bootstrap();
    await expect(getHandler('provider-auth:start')(createInvokeEvent(), PROVIDER)).resolves.toEqual(
      {
        state: 'awaiting_browser',
      }
    );
    await expect(
      getHandler('provider-auth:start')(createInvokeEvent(), PROVIDER, 'device')
    ).resolves.toEqual({ state: 'awaiting_browser' });
    await expect(
      getHandler('provider-auth:status')(createInvokeEvent(), PROVIDER)
    ).resolves.toEqual({ accountId: 'acct-77', state: 'connected' });
    await getHandler('provider-auth:cancel')(createInvokeEvent(), PROVIDER);
    await expect(
      getHandler('provider-auth:disconnect')(createInvokeEvent(), PROVIDER)
    ).resolves.toEqual({ state: 'disconnected' });
    expect(auth.connect.mock.calls).toEqual([
      [PROVIDER, undefined],
      [PROVIDER, 'device'],
    ]);
    expect(auth.status).toHaveBeenCalledWith(PROVIDER);
    expect(auth.cancel).toHaveBeenCalledWith(PROVIDER);
    expect(auth.disconnect).toHaveBeenCalledWith(PROVIDER);
  });

  it('rejects every hidden-host role and untracked senders on every channel (interactive-desktop pin)', async () => {
    const { auth, getHandler } = await bootstrap();
    for (const role of ['llm-host', 'embedding-host', 'chunking-host', undefined]) {
      getWindowRoleByWebContentsIdMock.mockReturnValue(role);
      for (const channel of ALL_CHANNELS) {
        await expect(getHandler(channel)(createInvokeEvent(), PROVIDER)).rejects.toThrow(
          /visible-ui/
        );
      }
    }
    for (const forwarded of Object.values(auth)) {
      expect(forwarded).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed provider ids instead of coercing them', async () => {
    const { auth, getHandler } = await bootstrap();
    for (const bad of ['', 42, null, undefined, {}]) {
      await expect(getHandler('provider-auth:status')(createInvokeEvent(), bad)).rejects.toThrow(
        /provider/i
      );
    }
    expect(auth.status).not.toHaveBeenCalled();
  });

  it('rejects malformed start methods instead of coercing them', async () => {
    const { auth, getHandler } = await bootstrap();
    await expect(
      getHandler('provider-auth:start')(createInvokeEvent(), PROVIDER, 'webview')
    ).rejects.toThrow(/method/i);
    expect(auth.connect).not.toHaveBeenCalled();
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
