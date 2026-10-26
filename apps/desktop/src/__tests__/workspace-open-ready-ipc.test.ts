import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAllowlistedSenderFrame,
  invokeDesktopIpcFrom,
  trackTestAppWindow,
} from './helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from './helpers/electron-main-test-harness';

// Import after the shared harness's global `vi.mock('electron', …)` (wired in
// `setup.ts`) is active, matching `logging-ipc.test.ts`'s convention for a
// `register*IpcHandlers` module.
const { registerWorkspaceOpenReadyIpcHandlers } = await import('../workspace-open-ready-ipc');

const METHOD = 'workspace:open-path-ready';

function appWindowEvent(senderId: number) {
  trackTestAppWindow(senderId);
  return { sender: { id: senderId }, senderFrame: createAllowlistedSenderFrame() };
}

function ping(event: unknown, payload: unknown): Promise<unknown> {
  return invokeDesktopIpcFrom(mockIpcMain, event, METHOD, payload);
}

describe('registerWorkspaceOpenReadyIpcHandlers', () => {
  let unregister: (() => void) | undefined;

  function register(onOpenPathReady = vi.fn()) {
    unregister = registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
    return onOpenPathReady;
  }

  beforeEach(() => {
    resetElectronMainTestHarness();
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it('routes a valid ping with the echoed reset generation', async () => {
    const onOpenPathReady = register();

    await ping(appWindowEvent(42), { resetGeneration: 'reset-42' });

    // Plain number, not the IpcMainEvent/WebContents object — this is what
    // lets `main.ts` route via a `Map<number, () => void>` keyed by
    // `webContents.id` instead of holding onto Electron event objects.
    expect(onOpenPathReady).toHaveBeenCalledExactlyOnceWith({
      kind: 'ready',
      resetGeneration: 'reset-42',
      senderWebContentsId: 42,
    });
  });

  it('routes a second ping from a DIFFERENT sender id independently', async () => {
    const onOpenPathReady = register();

    await ping(appWindowEvent(1), { resetGeneration: null });
    await ping(appWindowEvent(2), { resetGeneration: 'reset-2' });

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
    [undefined],
    [{ resetGeneration: 42 }],
    [{ resetGeneration: '' }],
    [{ extra: true, resetGeneration: 'reset-3' }],
  ])('routes an explicit diagnostic for a malformed ping (%j)', async (payload) => {
    const onOpenPathReady = register();

    await ping(appWindowEvent(3), payload);

    expect(onOpenPathReady).toHaveBeenCalledExactlyOnceWith({
      diagnostic: 'Renderer 3 readiness acknowledgement has malformed payload',
      kind: 'invalid',
      senderWebContentsId: 3,
    });
  });

  it('the returned unregister function stops serving the method', async () => {
    const onOpenPathReady = register();

    unregister?.();
    unregister = undefined;

    await expect(ping(appWindowEvent(5), { resetGeneration: null })).rejects.toThrow(
      `No desktop IPC handler for ${METHOD}.`
    );
    expect(onOpenPathReady).not.toHaveBeenCalled();
  });
});
