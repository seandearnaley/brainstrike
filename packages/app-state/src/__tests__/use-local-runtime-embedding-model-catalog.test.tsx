import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalRuntimeEmbeddingModelCatalog } from '../hooks/use-local-runtime-embedding-model-catalog';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';

describe('useLocalRuntimeEmbeddingModelCatalog', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
    vi.restoreAllMocks();
  });

  it('uses debug diagnostics for mount-triggered background refreshes', async () => {
    const getLocalRuntimeModels = vi.fn().mockResolvedValue({});
    useAssistantPreferencesStore.setState({ getLocalRuntimeModels });

    renderHook(() => useLocalRuntimeEmbeddingModelCatalog());

    await waitFor(() => {
      expect(getLocalRuntimeModels).toHaveBeenCalledTimes(1);
    });
    expect(getLocalRuntimeModels).toHaveBeenCalledWith({ diagnosticLogLevel: 'debug' });
  });

  it('preserves warn diagnostics for explicit forced refreshes', async () => {
    const getLocalRuntimeModels = vi.fn().mockResolvedValue({});
    useAssistantPreferencesStore.setState({ getLocalRuntimeModels });

    const { result } = renderHook(() => useLocalRuntimeEmbeddingModelCatalog());

    await waitFor(() => {
      expect(getLocalRuntimeModels).toHaveBeenCalledTimes(1);
    });
    getLocalRuntimeModels.mockClear();

    await act(async () => {
      await result.current.refresh({ force: true });
    });

    expect(getLocalRuntimeModels).toHaveBeenCalledWith({
      diagnosticLogLevel: 'warn',
      force: true,
    });
  });
});
