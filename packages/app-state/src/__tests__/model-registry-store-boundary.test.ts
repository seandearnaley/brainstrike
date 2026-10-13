import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import { __resetSettingsTestOverridesForTests } from '../testing/e2e-settings-test-overrides';

describe('model registry filesystem boundary', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
  });
  it('surfaces a filesystem refusal without claiming the registry loaded', async () => {
    const originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;
    try {
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        fileSystem: {
          exists: vi.fn().mockResolvedValue({
            error: refusal({
              category: 'availability',
              code: 'workspace.directory-unavailable',
              message: 'The cache folder is unavailable.',
              remedy: 'Choose an accessible cache folder.',
            }),
            ok: false,
          }),
        },
      };

      useModelRegistryStore.setState({
        downloadedModels: { 'local-model': true },
        modelCacheDir: '/cache',
      });

      const mockProviderRows = [
        { icon: null, id: 'local', is_enabled: true, name: 'Local', sort_order: 0 },
      ];
      const mockModelRows = [
        {
          best_for: null,
          capabilities: JSON.stringify({ type: 'embedding' }),
          description: 'Local model',
          icon: null,
          id: 'local-model',
          is_enabled: true,
          name: 'Local Model',
          parameters: null,
          provider_id: 'local',
          sort_order: 0,
          tagline: null,
        },
      ];

      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: mockProviderRows })
          .mockResolvedValueOnce({ rows: mockModelRows }),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().downloadedModels['local-model']).toBe(true);
      expect(useModelRegistryStore.getState().hasLoaded).toBe(false);
      expect(useModelRegistryStore.getState().error).toBe(
        'The cache folder is unavailable. Choose an accessible cache folder.'
      );
    } finally {
      (window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI;
    }
  });
});
