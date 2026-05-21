import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantAvailabilityWithLocal } from '../hooks/use-assistant-availability-with-local';

vi.mock('@brainstrike/assistant-contract/local-llm-device', () => ({
  getBestBuiltInLocalLlmDevice: vi.fn(() => 'webgpu'),
}));

// Mock the base hook
vi.mock('../hooks/use-assistant-availability', () => ({
  useAssistantAvailability: vi.fn(),
}));

vi.mock('@brainstrike/preferences/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
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

import { getBestBuiltInLocalLlmDevice } from '@brainstrike/assistant-contract/local-llm-device';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useAssistantAvailability } from '../hooks/use-assistant-availability';

const useAssistantAvailabilityMock = vi.mocked(useAssistantAvailability);
const useEnsureModelRegistryMock = vi.mocked(useEnsureModelRegistry);
const useModelRegistryStoreMock = vi.mocked(useModelRegistryStore);
const getBestBuiltInLocalLlmDeviceMock = vi.mocked(getBestBuiltInLocalLlmDevice);

describe('useAssistantAvailabilityWithLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBestBuiltInLocalLlmDeviceMock.mockReturnValue('webgpu');
    useEnsureModelRegistryMock.mockReturnValue(null);
  });

  it('returns enabled when server says enabled (hosted provider)', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'enabled' });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
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
      error: null,
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
      error: null,
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
      error: null,
      models: [],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
  });

  it('returns disabled when local Gemma cannot run on this device', () => {
    getBestBuiltInLocalLlmDeviceMock.mockReturnValue(null);
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      models: [
        {
          id: 'onnx-community/gemma-4-E2B-it-ONNX',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
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
      error: null,
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
      error: null,
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
      error: null,
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
      error: null,
      models: [],
      hasLoaded: false,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'loading' });
  });

  it('keeps loading while local model availability is still resolving', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
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

    expect(result.current).toEqual({ state: 'loading' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: true });
  });

  it('returns the hosted disabled state when the local registry fails to load', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: 'failed to load registry',
      models: [],
      hasLoaded: false,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: true });
  });

  it('returns disabled immediately when built-in local inference cannot run', () => {
    getBestBuiltInLocalLlmDeviceMock.mockReturnValue(null);
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'disabled',
      reason: 'missing_api_key',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      models: [
        {
          id: 'onnx-community/gemma-4-E2B-it-ONNX',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ],
      hasLoaded: false,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('returns error state from server', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      state: 'error',
      message: 'Network error',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
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
      error: null,
      models: [],
      hasLoaded: true,
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result, rerender } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'disabled', reason: 'missing_api_key' });

    // Now models become available
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
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
