import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnsureModelRegistry } from '../hooks/use-model-registry';
import { useModelRegistryStore } from '../stores/model-registry-store';

const dbHooks = vi.hoisted(() => ({
  useBrainstrikeDbClient: vi.fn(),
  useModelRegistryDbClient: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  useBrainstrikeDbClient: () => dbHooks.useBrainstrikeDbClient(),
  useModelRegistryDbClient: () => dbHooks.useModelRegistryDbClient(),
}));

describe('useEnsureModelRegistry', () => {
  const originalEnsureRegistry = useModelRegistryStore.getState().ensureRegistry;

  afterEach(() => {
    vi.clearAllMocks();
    useModelRegistryStore.setState({
      error: null,
      ensureRegistry: originalEnsureRegistry,
      hasLoaded: false,
      isLoading: false,
    });
  });

  it('uses the model-registry database client when no explicit db is provided', async () => {
    const registryDb = { query: vi.fn() };
    const ensureRegistry = vi.fn(async () => {});
    dbHooks.useBrainstrikeDbClient.mockReturnValue(null);
    dbHooks.useModelRegistryDbClient.mockReturnValue(registryDb);
    useModelRegistryStore.setState({ ensureRegistry });

    const { unmount } = renderHook(() => useEnsureModelRegistry());

    await waitFor(() => {
      expect(ensureRegistry).toHaveBeenCalledWith(registryDb);
    });

    unmount();
  });
});
