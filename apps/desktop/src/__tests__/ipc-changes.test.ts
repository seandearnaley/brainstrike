import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerChangesIpcHandlers } from '../ipc-changes';
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

// BST-1641: every `changes` channel is visible-UI-only, so dispatches carry a
// sender that passes both factors (tracked role + allowlisted frame).
const trustedEvent = createTrustedInvokeEvent();

/**
 * A tracked gap from Task 1's review: nothing previously asserted that
 * `resolveView`/`fileDiff` register against the CORRECT
 * `DESKTOP_IPC_CHANNELS.changes.*` constants (a copy-paste channel swap would
 * fail nothing), or that the disposer actually removes both.
 */
function stubHandlers() {
  return {
    fileDiff: vi.fn(async () => ({ ok: true, value: {} }) as never),
    inventory: vi.fn(async () => ({ ok: true, value: {} }) as never),
    resolveView: vi.fn(async () => ({ ok: true, value: {} }) as never),
  };
}

describe('registerChangesIpcHandlers', () => {
  // The `ipcMain` mock is module-scoped, so its `handle` calls accumulate
  // across tests: without this, looking a channel up by `find` returns the
  // FIRST test's handler and every forwarding assertion silently tests the
  // wrong closure.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers resolveView and fileDiff against the correct channel constants', async () => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();

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
    )?.[1] as (event: unknown, options?: unknown) => unknown;
    const resolveViewHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.resolveView
    )?.[1] as (event: unknown, rootId: unknown, changeset: unknown) => unknown;
    const fileDiffHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.fileDiff
    )?.[1] as (event: unknown, rootId: unknown, changeset: unknown, path: unknown) => unknown;

    // Prove each registered channel is wired to the RIGHT handler function —
    // a wrong-channel copy-paste (both pointing at the same handler, or
    // swapped) would still pass the presence assertion above but fail here.
    const changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' };
    await resolveViewHandler(trustedEvent, 'root-1', changeset);
    expect(handlers.resolveView).toHaveBeenCalledWith('root-1', changeset);
    expect(handlers.fileDiff).not.toHaveBeenCalled();

    await fileDiffHandler(trustedEvent, 'root-1', changeset, 'src/file.ts');
    expect(handlers.fileDiff).toHaveBeenCalledWith('root-1', changeset, 'src/file.ts');

    // BST-1114 T0 / BST-1397: `inventory` takes ONE optional renderer argument
    // (`{ maxAgeMs }`, the forced-refresh knob) — assert the registered thunk
    // forwards exactly that argument and NEVER the raw IpcMainInvokeEvent (a
    // `(...args) => handlers.inventory(...args)` slip would leak the event).
    const fakeEvent = trustedEvent;
    await inventoryHandler(fakeEvent);
    expect(handlers.inventory).toHaveBeenLastCalledWith({});
    await inventoryHandler(fakeEvent, { maxAgeMs: 0 });
    expect(handlers.inventory).toHaveBeenLastCalledWith({ maxAgeMs: 0 });
    expect(handlers.inventory).not.toHaveBeenCalledWith(fakeEvent, expect.anything());
    expect(handlers.inventory).not.toHaveBeenCalledWith(fakeEvent);
  });

  it('disposer removes every registered channel', async () => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();

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

  it('preserves raw GitResult failures for type-valid inventory limits', async () => {
    const { ipcMain } = await import('electron');
    const inventoryFailure = { error: 'maxAgeMs must be finite', ok: false } as const;
    const handlers = {
      ...stubHandlers(),
      inventory: vi.fn(async () => inventoryFailure),
    };
    registerChangesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const inventoryHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.changes.inventory
    )?.[1] as (event: unknown, options: unknown) => unknown;

    await expect(inventoryHandler(trustedEvent, { maxAgeMs: Number.NaN })).resolves.toBe(
      inventoryFailure
    );
    expect(handlers.inventory).toHaveBeenCalledWith({ maxAgeMs: Number.NaN });
  });

  it('does not expose a second rewind writer through the Changes bridge', async () => {
    const { ipcMain } = await import('electron');
    registerChangesIpcHandlers(stubHandlers());
    const registered = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
    for (const channel of [
      'changes:applyRewind',
      'changes:finalizeRewinds',
      'changes:redoRewind',
      'changes:rewindPreview',
    ]) {
      expect(registered).not.toContain(channel);
    }
  });
});
