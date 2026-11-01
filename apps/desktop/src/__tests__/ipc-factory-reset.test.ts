import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from '../ipc-factory-reset';
import {
  createAllowlistedSenderFrame,
  invokeDesktopIpc,
  invokeDesktopIpcFrom,
} from './helpers/desktop-ipc-sender-test-helpers';

const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => ({ ipcMain }));

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});
function invoke(method: string, ...args: unknown[]) {
  return invokeDesktopIpc(ipcMain, method, ...args);
}
/** A sender that is not a tracked app window, on an otherwise trusted frame. */
function invokeFromUntrackedSender(method: string, ...args: unknown[]) {
  return invokeDesktopIpcFrom(
    ipcMain,
    { sender: { id: 970_404 }, senderFrame: createAllowlistedSenderFrame() },
    method,
    ...args
  );
}
describe('current profile reset and path IPC', () => {
  it('awaits the existing reset owner and retains its result without a database owner', async () => {
    // Windows refuses reset before the owner (pinned below); admit it here on every OS.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const completion = Promise.withResolvers<{ success: boolean; message?: string }>();
    const reset = vi.fn(() => completion.promise);
    const close = registerFactoryResetIpcHandlers(reset);
    const result = invoke('db:resetLocal');
    expect(reset).toHaveBeenCalledOnce();
    completion.resolve({ message: 'reset refused', success: false });
    await expect(result).resolves.toEqual({ message: 'reset refused', success: false });
    close();
    await expect(invoke('db:resetLocal')).rejects.toThrow(
      'No desktop IPC handler for db:resetLocal.'
    );
  });
  it('preserves Windows reset admission without invoking the owner', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const reset = vi.fn(async () => ({ success: true }));
    const close = registerFactoryResetIpcHandlers(reset);
    await expect(invoke('db:resetLocal')).resolves.toMatchObject({ success: false });
    expect(reset).not.toHaveBeenCalled();
    close();
  });
  it('refuses non-window callers and malformed reset arguments before mutation', async () => {
    const reset = vi.fn(async () => ({ success: true }));
    const close = registerFactoryResetIpcHandlers(reset);
    await expect(invokeFromUntrackedSender('db:resetLocal')).rejects.toThrow(
      'Desktop IPC db:resetLocal requires an app window sender.'
    );
    await expect(invoke('db:resetLocal', 'extra')).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
    close();
  });
  it('returns the injected current profile path and removes its handler', async () => {
    const close = registerProfilePathIpcHandlers(() => '/tmp/disposable/current-profile');
    await expect(invoke('db:getUserDataPath')).resolves.toBe('/tmp/disposable/current-profile');
    close();
    await expect(invoke('db:getUserDataPath')).rejects.toThrow(
      'No desktop IPC handler for db:getUserDataPath.'
    );
  });
});

it('content clear uses the existing host owner only after visible confirmation', async () => {
  const { registerContentClearIpcHandlers } = await import('../ipc-factory-reset');
  const clear = vi.fn(async (): Promise<void> => undefined);
  const close = registerContentClearIpcHandlers(clear);
  try {
    await expect(invoke('db:clearAll', 'wrong')).rejects.toThrow();
    await expect(
      invokeFromUntrackedSender('db:clearAll', 'CONFIRM_CLEAR_DATABASE')
    ).rejects.toThrow('Desktop IPC db:clearAll requires an app window sender.');
    expect(clear).not.toHaveBeenCalled();
    await expect(invoke('db:clearAll', 'CONFIRM_CLEAR_DATABASE')).resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    close();
  }
});
