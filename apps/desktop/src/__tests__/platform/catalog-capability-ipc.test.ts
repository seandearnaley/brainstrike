import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { registerModelCatalogIpc } from '../../ipc-model-catalog';
import {
  createTrustedInvokeEvent,
  invokeDesktopIpcFrom,
} from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain } from '../helpers/electron-main-test-harness';

const sender = 8_910_001;
function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  return invokeDesktopIpcFrom(mockIpcMain, createTrustedInvokeEvent(sender), method, ...args);
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
