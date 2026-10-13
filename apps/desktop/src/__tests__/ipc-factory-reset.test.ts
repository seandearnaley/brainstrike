import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from './helpers/desktop-ipc-sender-test-helpers';

const { handlers, removeHandler } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import {
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from '../ipc-factory-reset';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  handlers.clear();
  vi.clearAllMocks();
});
function invoke(
  channel: string,
  role: 'visible-ui' | 'chunking-host' = 'visible-ui',
  ...args: unknown[]
) {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error('Missing registered operation');
  }
  return handler(createTrustedInvokeEvent(role), ...args);
}
describe('current profile reset and path IPC', () => {
  it('awaits the existing reset owner and retains its result without a database owner', async () => {
    const completion = Promise.withResolvers<{ success: boolean; message?: string }>();
    const reset = vi.fn(() => completion.promise);
    const close = registerFactoryResetIpcHandlers(reset);
    const result = invoke('db:resetLocal');
    expect(reset).toHaveBeenCalledOnce();
    completion.resolve({ message: 'reset refused', success: false });
    await expect(result).resolves.toEqual({ message: 'reset refused', success: false });
    close();
    expect(removeHandler).toHaveBeenCalledWith('db:resetLocal');
  });
  it('preserves Windows reset admission without invoking the owner', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const reset = vi.fn(async () => ({ success: true }));
    const close = registerFactoryResetIpcHandlers(reset);
    await expect(invoke('db:resetLocal')).resolves.toMatchObject({ success: false });
    expect(reset).not.toHaveBeenCalled();
    close();
  });
  it('refuses hidden callers and malformed reset arguments before mutation', async () => {
    const reset = vi.fn(async () => ({ success: true }));
    const close = registerFactoryResetIpcHandlers(reset);
    await expect(invoke('db:resetLocal', 'chunking-host')).rejects.toThrow();
    await expect(invoke('db:resetLocal', 'visible-ui', 'extra')).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
    close();
  });
  it('returns the injected current profile path and removes its handler', async () => {
    const close = registerProfilePathIpcHandlers(() => '/tmp/disposable/current-profile');
    await expect(invoke('db:getUserDataPath')).resolves.toBe('/tmp/disposable/current-profile');
    close();
    expect(removeHandler).toHaveBeenCalledWith('db:getUserDataPath');
  });
});

it('content clear uses the existing host owner only after visible confirmation', async () => {
  const { registerContentClearIpcHandlers } = await import('../ipc-factory-reset');
  const clear = vi.fn(async () => ({ deletedChunks: null, deletedFiles: 2 }));
  const close = registerContentClearIpcHandlers(clear);
  try {
    await expect(invoke('db:clearAll', 'visible-ui', 'wrong')).rejects.toThrow();
    await expect(
      invoke('db:clearAll', 'chunking-host', 'CONFIRM_CLEAR_DATABASE')
    ).rejects.toThrow();
    expect(clear).not.toHaveBeenCalled();
    await expect(invoke('db:clearAll', 'visible-ui', 'CONFIRM_CLEAR_DATABASE')).resolves.toEqual({
      deletedChunks: null,
      deletedFiles: 2,
    });
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    close();
  }
});
