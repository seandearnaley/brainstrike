import { afterEach, expect, test, vi } from 'vitest';
import { createTrustedInvokeEvent } from './helpers/desktop-ipc-sender-test-helpers';

const { handlers, removeHandler } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import { registerViewFilterPresetsIpc } from '../ipc-view-filter-presets';

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});
function invoke(role: 'visible-ui' | 'embedding-host', input: unknown) {
  const handler = handlers.get('view-filter-presets:request');
  if (!handler) {
    throw new Error('Preset IPC not registered');
  }
  return handler(createTrustedInvokeEvent(role), input);
}
test('visible preset writes reach the injected owner once and hidden/malformed writes never do', async () => {
  const viewFilterPresets = vi.fn(async () => ({ deleted: true, presets: [] }));
  const close = registerViewFilterPresetsIpc({ viewFilterPresets });
  await expect(invoke('visible-ui', { id: 'preset', operation: 'delete' })).resolves.toMatchObject({
    ok: true,
  });
  expect(viewFilterPresets).toHaveBeenCalledWith({ id: 'preset', operation: 'delete' });
  await expect(invoke('embedding-host', { id: 'preset', operation: 'delete' })).rejects.toThrow();
  await expect(
    invoke('visible-ui', { id: 'preset', input: { isDefault: true }, operation: 'update' })
  ).rejects.toThrow();
  await expect(
    invoke('visible-ui', {
      input: { excludes: [], icon: 'unknown', includes: [], name: 'test' },
      operation: 'create',
    })
  ).rejects.toThrow();
  expect(viewFilterPresets).toHaveBeenCalledOnce();
  close();
  expect(removeHandler).toHaveBeenCalledWith('view-filter-presets:request');
});
