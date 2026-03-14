import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantAvailabilityWithLocal } from '../hooks/use-assistant-availability-with-local';

// Mock the base hook
vi.mock('../hooks/use-assistant-availability', () => ({
  useAssistantAvailability: vi.fn(),
}));

// Mock the model registry store
vi.mock('@brainstrike/preferences/stores/model-registry-store', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@brainstrike/preferences/stores/model-registry-store')>();
  return {
    ...real,
    useModelRegistryStore: vi.fn(),
  };
});

import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useAssistantAvailability } from '../hooks/use-assistant-availability';

const useAssistantAvailabilityMock = vi.mocked(useAssistantAvailability);
const useModelRegistryStoreMock = vi.mocked(useModelRegistryStore);

describe('useAssistantAvailabilityWithLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enabled when server says enabled (hosted provider)', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'enabled' });
    useModelRegistryStoreMock.mockReturnValue({
      models: [],
      hasLoaded: false,
    } as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns enabled when local LLM models are available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns enabled when transformers provider models are available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'transformers',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns disabled when no local models and server disabled', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns disabled when local models exist but are not enabled', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          isEnabled: false, // Not enabled
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns disabled when local embedding models exist (not LLM)', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'embedding' }, // Not LLM
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns disabled when model rows are malformed', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'malformed-model',
          providerId: 'local',
          isEnabled: true,
          capabilities: null,
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns loading when server is loading', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'loading' });
    useModelRegistryStoreMock.mockReturnValue({
      models: [],
      hasLoaded: false,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'loading' });
  });

  it('returns disabled when model registry not loaded yet', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: false, // Not loaded yet
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    // Returns disabled because hasLoaded is false
    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns error state from server', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'error',
      message: 'Network error',
    });
    useModelRegistryStoreMock.mockReturnValue({
      models: [],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'error', message: 'Network error' });
  });

  it('updates when local models become available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });

    // Start with no models
    useModelRegistryStoreMock.mockReturnValue({
      models: [],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result, rerender } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });

    // Now models become available
    useModelRegistryStoreMock.mockReturnValue({
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    rerender();

    expect(result.current).toEqual({ state: 'enabled' });
  });
});
