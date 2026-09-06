import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ProviderAuthEngine } from '../../provider-auth/provider-auth-engine';
import {
  createAllowlistedSenderFrame,
  reconfigureTestRendererTargetAfterModuleReset,
} from '../helpers/desktop-ipc-sender-frame-test-allowlist';
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
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

async function bootstrap(engineOverrides: Partial<ProviderAuthEngine> = {}) {
  vi.resetModules();
  await reconfigureTestRendererTargetAfterModuleReset();
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

  it('a FULL loopback flow and a FULL device flow leak no token material through any observed status (gate constraint 3, load-bearing)', async () => {
    // Security-review finding 9: the sentinel assertion must observe every
    // status a real flow produces (awaiting_browser, awaiting_device_code
    // with user code, connected with accountId) — not just idle reads.
    vi.resetModules();
    await reconfigureTestRendererTargetAfterModuleReset();
    const { createProviderAuthEngine } = await import('../../provider-auth/provider-auth-engine');
    const { registerProviderAuthIpcHandlers } = await import('../../ipc-domains/provider-auth');
    const { ipcMain } = await import('electron');

    const ID_TOKEN_SENTINEL = 'ID-TOKEN-SENTINEL-4e1b';
    const tokenBody = JSON.stringify({
      access_token: ACCESS_SENTINEL,
      account_id: 'acct-sentinel-9',
      expires_in: 3600,
      id_token: ID_TOKEN_SENTINEL,
      refresh_token: REFRESH_SENTINEL,
      token_type: 'Bearer',
    });
    const deviceStartBody = JSON.stringify({
      device_code: 'device-code-sentinel',
      expires_in: 600,
      interval: 1,
      user_code: 'CODE-1234',
      verification_uri: 'https://provider.test/activate',
    });
    const fetchFn = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/device/code')) {
        return new Response(deviceStartBody, { status: 200 });
      }
      return new Response(tokenBody, { status: 200 });
    }) as unknown as typeof fetch;

    const secrets = makeFakeSecrets();
    const engine = createProviderAuthEngine({
      fetchFn,
      getDescriptor: () => ({
        authorizeUrl: 'https://provider.test/authorize',
        clientId: 'client-sentinel',
        deviceFlow: {
          pollUrl: 'https://provider.test/device/token',
          startUrl: 'https://provider.test/device/code',
          verificationUri: 'https://provider.test/activate',
        },
        extractAccountId: (grant) => {
          const accountId = grant.raw['account_id'];
          return typeof accountId === 'string' ? accountId : undefined;
        },
        providerId: PROVIDER,
        redirectPath: '/callback',
        redirectPort: 43_210,
        scopes: ['openid', 'offline_access'],
        tokenUrl: 'https://provider.test/token',
      }),
      openExternal: async () => undefined,
      secrets,
      sleep: async () => undefined,
      // Fake loopback that delivers the code as soon as the flow waits on it.
      startLoopbackServerFn: async () => ({
        cancel: () => undefined,
        close: async () => undefined,
        port: 43_210,
        redirectUri: 'http://127.0.0.1:43210/callback',
        waitForCallback: () =>
          new Promise((resolve) => {
            setImmediate(() => resolve({ code: 'flow-code' }));
          }),
      }),
    });
    registerProviderAuthIpcHandlers({ engine });
    const handleMock = ipcMain.handle as unknown as Mock<
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
    >;
    const handler = (channel: string) => {
      const entry = handleMock.mock.calls.find(([name]) => name === channel);
      if (!entry?.[1]) {
        throw new Error(`channel not registered: ${channel}`);
      }
      return entry[1];
    };

    const observed: unknown[] = [];
    const observe = async (channel: string, ...args: unknown[]) => {
      const status = await handler(channel)(createInvokeEvent(), PROVIDER, ...args);
      observed.push(status);
      return status;
    };

    // Full loopback flow.
    expect(await observe('provider-auth:start')).toEqual({ state: 'awaiting_browser' });
    await vi.waitFor(async () => {
      const status = await observe('provider-auth:status');
      expect(status).toEqual({ accountId: 'acct-sentinel-9', state: 'connected' });
    });
    expect(secrets.store.get(PROVIDER)).toMatchObject({ access: ACCESS_SENTINEL });
    expect(await observe('provider-auth:disconnect')).toEqual({ state: 'disconnected' });

    // Full device flow.
    expect(await observe('provider-auth:start', 'device')).toEqual({
      state: 'awaiting_device_code',
      userCode: 'CODE-1234',
      verificationUri: 'https://provider.test/activate',
    });
    await vi.waitFor(async () => {
      const status = await observe('provider-auth:status');
      expect(status).toEqual({ accountId: 'acct-sentinel-9', state: 'connected' });
    });

    const serialized = JSON.stringify(observed);
    expect(observed.length).toBeGreaterThanOrEqual(6);
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect(serialized).not.toContain(REFRESH_SENTINEL);
    expect(serialized).not.toContain(ID_TOKEN_SENTINEL);
    expect(serialized).not.toMatch(/access_token|refresh_token|id_token/i);
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
