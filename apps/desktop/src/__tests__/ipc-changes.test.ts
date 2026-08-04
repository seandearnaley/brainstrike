import { describe, expect, it, vi } from 'vitest';
import { registerChangesIpcHandlers } from '../ipc-changes';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

/**
 * A tracked gap from Task 1's review: nothing previously asserted that
 * `resolveView`/`fileDiff` register against the CORRECT
 * `DESKTOP_IPC_CHANNELS.changes.*` constants (a copy-paste channel swap would
 * fail nothing), or that the disposer actually removes both.
 */
describe('registerChangesIpcHandlers', () => {
  it('registers resolveView and fileDiff against the correct channel constants', async () => {
    const { ipcMain } = await import('electron');
    const handlers = {
      fileDiff: vi.fn(async () => ({ ok: true, value: {} }) as never),
      inventory: vi.fn(async () => ({ ok: true, value: {} }) as never),
      resolveView: vi.fn(async () => ({ ok: true, value: {} }) as never),
    };

    registerChangesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const registeredChannels = handleMock.mock.calls.map(([channel]) => channel);
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.changes.resolveView,
        DESKTOP_IPC_CHANNELS.changes.fileDiff,
        DESKTOP_IPC_CHANNELS.changes.inventory,
      ])
    );

    const inventoryHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.inventory
    )?.[1] as (event: unknown) => unknown;
    const resolveViewHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.resolveView
    )?.[1] as (event: unknown, rootId: unknown, changeset: unknown) => unknown;
    const fileDiffHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.fileDiff
    )?.[1] as (event: unknown, rootId: unknown, changeset: unknown, path: unknown) => unknown;

    // Prove each registered channel is wired to the RIGHT handler function —
    // a wrong-channel copy-paste (both pointing at the same handler, or
    // swapped) would still pass the presence assertion above but fail here.
    await resolveViewHandler({}, 'root-1', { kind: 'agent-run' });
    expect(handlers.resolveView).toHaveBeenCalledWith('root-1', { kind: 'agent-run' });
    expect(handlers.fileDiff).not.toHaveBeenCalled();

    await fileDiffHandler({}, 'root-1', { kind: 'agent-run' }, 'src/file.ts');
    expect(handlers.fileDiff).toHaveBeenCalledWith('root-1', { kind: 'agent-run' }, 'src/file.ts');

    // BST-1114 T0: `inventory` takes no renderer arguments — assert the
    // registered thunk forwards NOTHING (a `(...args) => handlers.inventory(...args)`
    // slip would leak the raw IpcMainInvokeEvent into the handler).
    await inventoryHandler({});
    expect(handlers.inventory).toHaveBeenCalledWith();
  });

  it('disposer removes every registered channel', async () => {
    const { ipcMain } = await import('electron');
    const handlers = {
      fileDiff: vi.fn(async () => ({ ok: true, value: {} }) as never),
      inventory: vi.fn(async () => ({ ok: true, value: {} }) as never),
      resolveView: vi.fn(async () => ({ ok: true, value: {} }) as never),
    };

    const dispose = registerChangesIpcHandlers(handlers);
    dispose();

    const removeHandlerMock = ipcMain.removeHandler as unknown as ReturnType<typeof vi.fn>;
    const removedChannels = removeHandlerMock.mock.calls.map(([channel]) => channel);
    expect(removedChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.changes.resolveView,
        DESKTOP_IPC_CHANNELS.changes.fileDiff,
        DESKTOP_IPC_CHANNELS.changes.inventory,
      ])
    );
    expect(removedChannels).toHaveLength(3);
  });
});
