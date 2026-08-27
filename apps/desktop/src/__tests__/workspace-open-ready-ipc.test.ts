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

  it('routes a ping to onOpenPathReady with the SENDER webContents id, not the whole event', () => {
    const onOpenPathReady = vi.fn();
    registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
    const listener = getRegisteredIpcMainListener(CHANNEL);

    listener({ sender: { id: 42 } });

    // Plain number, not the IpcMainEvent/WebContents object — this is what
    // lets `main.ts` route via a `Map<number, () => void>` keyed by
    // `webContents.id` instead of holding onto Electron event objects.
    expect(onOpenPathReady).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('routes a second ping from a DIFFERENT sender id independently', () => {
    const onOpenPathReady = vi.fn();
    registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady });
    const listener = getRegisteredIpcMainListener(CHANNEL);

    listener({ sender: { id: 1 } });
    listener({ sender: { id: 2 } });

    expect(onOpenPathReady).toHaveBeenNthCalledWith(1, 1);
    expect(onOpenPathReady).toHaveBeenNthCalledWith(2, 2);
  });

  it('the returned unregister function removes the listener', () => {
    const unregister = registerWorkspaceOpenReadyIpcHandlers({ onOpenPathReady: vi.fn() });

    unregister();

    expect(() => getRegisteredIpcMainListener(CHANNEL)).toThrow(/No ipcMain.on registration found/);
  });
});
