import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { beforeEach, expect, test, vi } from 'vitest';
import { registerModelCatalogIpc } from '../../ipc-model-catalog';
import {
  createTrustedInvokeEvent,
  trackTestWindowRole,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from '../helpers/electron-main-test-harness';

const sender = 8_910_001;
beforeEach(() => {
  resetElectronMainTestHarness();
  trackTestWindowRole(sender, 'visible-ui');
});
function invoke(channel: string, ...args: unknown[]): unknown {
  const registered = mockIpcMain.handle.mock.calls.find(([name]) => name === channel);
  if (!registered) {
    throw new Error(`Missing channel ${channel}`);
  }
  return registered[1](createTrustedInvokeEvent('visible-ui', sender), ...args);
}
test('model mutations receive exactly the parsed renderer arguments through registered IPC', async () => {
  const snapshot = { models: [], providers: [] };
  const catalog: ModelCatalogCapability = {
    initializeProviderDefaults: vi.fn(async () => ({ outcome: 'preserved' as const, snapshot })),
    read: vi.fn(async () => snapshot),
    setModels: vi.fn(async () => ({ previous: [], snapshot })),
    setProvider: vi.fn(async () => snapshot),
  };
  const dispose = registerModelCatalogIpc(catalog);
  try {
    expect(await invoke('model-catalog:set-provider', 'openai', true)).toEqual({
      ok: true,
      value: snapshot,
    });
    expect(catalog.setProvider).toHaveBeenCalledWith('openai', true);
    await invoke('model-catalog:set-models', ['model-id'], false);
    expect(catalog.setModels).toHaveBeenCalledWith(['model-id'], false);
    await invoke('model-catalog:initialize-provider-defaults', 'openai', {
      kind: 'seed',
      modelIds: ['model-id'],
    });
    expect(catalog.initializeProviderDefaults).toHaveBeenCalledWith('openai', {
      kind: 'seed',
      modelIds: ['model-id'],
    });
  } finally {
    dispose();
  }
});
