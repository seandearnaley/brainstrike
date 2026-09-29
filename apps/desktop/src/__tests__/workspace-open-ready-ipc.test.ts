import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRegisteredIpcMainListener,
  resetElectronMainTestHarness,
} from './helpers/electron-main-test-harness';

// Import after the shared harness's global `vi.mock('electron', …)` (wired in
// `setup.ts`) is active, matching `logging-ipc.test.ts`'s convention for a
// `register*IpcHandlers` module.
const { registerWorkspaceOpenReadyIpcHandlers } = await import('../workspace-open-ready-ipc');

const CHANNEL = 'workspace:open-path-ready';

describe('registerWorkspaceOpenReadyIpcHandlers', () => {
  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  it('registers the workspace:open-path-ready event channel', () => {
    registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady: vi.fn() });

    expect(() => getRegisteredIpcMainListener(CHANNEL)).not.toThrow();
  });

  it('routes a valid ping with the echoed reset generation', () => {
    const onOpenPathReady = vi.fn();
    registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
    const listener = getRegisteredIpcMainListener(CHANNEL);

    listener(
      { sender: { id: 42 }, senderFrame: { processId: 7, routingId: 9 } },
      { resetGeneration: 'reset-42' }
    );

    // Plain number, not the IpcMainEvent/WebContents object — this is what
    // lets `main.ts` route via a `Map<number, () => void>` keyed by
    // `webContents.id` instead of holding onto Electron event objects.
    expect(onOpenPathReady).toHaveBeenCalledExactlyOnceWith({
      kind: 'ready',
      resetGeneration: 'reset-42',
      senderWebContentsId: 42,
    });
  });

  it('routes a second ping from a DIFFERENT sender id independently', () => {
    const onOpenPathReady = vi.fn();
    registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
    const listener = getRegisteredIpcMainListener(CHANNEL);

    listener(
      { sender: { id: 1 }, senderFrame: { processId: 10, routingId: 11 } },
      { resetGeneration: null }
    );
    listener(
      { sender: { id: 2 }, senderFrame: { processId: 12, routingId: 13 } },
      { resetGeneration: 'reset-2' }
    );

    expect(onOpenPathReady).toHaveBeenNthCalledWith(1, {
      kind: 'ready',
      resetGeneration: null,
      senderWebContentsId: 1,
    });
    expect(onOpenPathReady).toHaveBeenNthCalledWith(2, {
      kind: 'ready',
      resetGeneration: 'reset-2',
      senderWebContentsId: 2,
    });
  });

  it.each([
    [null, { resetGeneration: 'reset-3' }, 'has no sender frame'],
    [{ processId: 14, routingId: 15 }, undefined, 'has malformed payload'],
    [{ processId: 14, routingId: 15 }, { resetGeneration: 42 }, 'has malformed payload'],
    [{ processId: 14, routingId: 15 }, { resetGeneration: '' }, 'has malformed payload'],
    [
      { processId: 14, routingId: 15 },
      { extra: true, resetGeneration: 'reset-3' },
      'has malformed payload',
    ],
  ])(
    'routes an explicit diagnostic for a frameless or malformed ping',
    (senderFrame, payload, message) => {
      const onOpenPathReady = vi.fn();
      registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
      const listener = getRegisteredIpcMainListener(CHANNEL);

      listener({ sender: { id: 3 }, senderFrame }, payload);

      expect(onOpenPathReady).toHaveBeenCalledExactlyOnceWith({
        diagnostic: `Renderer 3 readiness acknowledgement ${message}`,
        kind: 'invalid',
        senderWebContentsId: 3,
      });
    }
  );

  it('the returned unregister function removes the listener', () => {
    const unregister = registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady: vi.fn() });

    unregister();

    expect(() => getRegisteredIpcMainListener(CHANNEL)).toThrow(/No ipcMain.on registration found/);
  });
});
