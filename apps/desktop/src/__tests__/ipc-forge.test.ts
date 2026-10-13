import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerForgeIpcHandlers } from '../ipc-forge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createTrustedInvokeEvent } from './helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

/**
 * Mirrors `ipc-changes.test.ts`'s tracked gap: nothing previously asserted
 * that `identity`/`prStatus`/`refresh` register against the CORRECT
 * `DESKTOP_IPC_CHANNELS.forge.*` constants (a copy-paste channel swap would
 * fail nothing), that `refresh` forwards `(rootId, params)` in order, that
 * the disposer removes all four, or that `prUpdated` — the doc comment's
 * "never an invoke channel" claim — is actually never registered.
 */
function stubHandlers() {
  return {
    cacheSnapshot: vi.fn(async () => ({ ok: true, value: [] }) as never),
    identity: vi.fn(async () => ({ ok: true, value: {} }) as never),
    prStatus: vi.fn(async () => ({ ok: true, value: {} }) as never),
    refresh: vi.fn(async () => ({ ok: true, value: {} }) as never),
  };
}

describe('registerForgeIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers each channel against its own handler and never registers prUpdated', async () => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();

    registerForgeIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const registeredChannels = handleMock.mock.calls.map(([channel]) => channel);
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.forge.cacheSnapshot,
        DESKTOP_IPC_CHANNELS.forge.identity,
        DESKTOP_IPC_CHANNELS.forge.prStatus,
        DESKTOP_IPC_CHANNELS.forge.refresh,
      ])
    );
    // Falsifies the doc comment's claim that `prUpdated` is a push-only event,
    // never an ipcMain.handle invoke channel.
    expect(registeredChannels).not.toContain(DESKTOP_IPC_CHANNELS.forge.prUpdated);

    const handlerFor = (channel: string) =>
      handleMock.mock.calls.find(([registered]) => registered === channel)?.[1] as (
        event: unknown,
        ...args: unknown[]
      ) => unknown;

    const trustedEvent = createTrustedInvokeEvent();
    await handlerFor(DESKTOP_IPC_CHANNELS.forge.cacheSnapshot)(trustedEvent);
    expect(handlers.cacheSnapshot).toHaveBeenCalledWith();
    await handlerFor(DESKTOP_IPC_CHANNELS.forge.identity)(trustedEvent, 'root-1');
    expect(handlers.identity).toHaveBeenCalledWith('root-1');
    expect(handlers.prStatus).not.toHaveBeenCalled();

    await handlerFor(DESKTOP_IPC_CHANNELS.forge.prStatus)(trustedEvent, 'root-1');
    expect(handlers.prStatus).toHaveBeenCalledWith('root-1');

    await handlerFor(DESKTOP_IPC_CHANNELS.forge.refresh)(trustedEvent, 'root-1', {
      reason: 'user',
    });
    expect(handlers.refresh).toHaveBeenCalledWith('root-1', { reason: 'user' });
  });

  it('disposer removes all four registered channels', async () => {
    const { ipcMain } = await import('electron');
    const dispose = registerForgeIpcHandlers(stubHandlers());

    dispose();

    const removeHandlerMock = ipcMain.removeHandler as unknown as ReturnType<typeof vi.fn>;
    const removedChannels = removeHandlerMock.mock.calls.map(([channel]) => channel);
    expect(removedChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.forge.cacheSnapshot,
        DESKTOP_IPC_CHANNELS.forge.identity,
        DESKTOP_IPC_CHANNELS.forge.prStatus,
        DESKTOP_IPC_CHANNELS.forge.refresh,
      ])
    );
    expect(removedChannels).toHaveLength(4);
  });
});
