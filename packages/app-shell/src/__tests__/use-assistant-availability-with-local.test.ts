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
      hasLoaded: false,
      models: [],
    } as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns enabled when local LLM models are available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'test-model',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns enabled when transformers provider models are available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'test-model',
          isEnabled: true,
          providerId: 'transformers',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'enabled' });
  });

  it('returns disabled when no local models and server disabled', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
  });

  it('returns disabled when local Gemma cannot run on this device', () => {
    getBestBuiltInLocalLlmDeviceMock.mockReturnValue(null);
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'onnx-community/gemma-4-E2B-it-ONNX',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
  });

  it('returns disabled when local models exist but are not enabled', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'test-model',
          isEnabled: false, // Not enabled
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
  });

  it('returns disabled when local embedding models exist (not LLM)', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'embedding' }, // Not LLM
          id: 'test-model',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
  });

  it('returns disabled when model rows are malformed', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: null,
          id: 'malformed-model',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
  });

  it('returns loading when server is loading', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'loading' });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: false,
      models: [],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'loading' });
  });

  it('keeps loading while local model availability is still resolving', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: false, // Not loaded yet
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'test-model',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ state: 'loading' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: true });
  });

  it('returns the hosted disabled state when the local registry fails to load', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: 'failed to load registry',
      hasLoaded: false,
      models: [],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: true });
  });

  it('returns disabled immediately when built-in local inference cannot run', () => {
    getBestBuiltInLocalLlmDeviceMock.mockReturnValue(null);
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: false,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'onnx-community/gemma-4-E2B-it-ONNX',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });
    expect(useEnsureModelRegistryMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('returns error state from server', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      message: 'Network error',
      state: 'error',
    });
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ message: 'Network error', state: 'error' });
  });

  it('updates when local models become available', () => {
    useAssistantAvailabilityMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });

    // Start with no models
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    const { result, rerender } = renderHook(() => useAssistantAvailabilityWithLocal());

    expect(result.current).toEqual({ reason: 'missing_api_key', state: 'disabled' });

    // Now models become available
    useModelRegistryStoreMock.mockReturnValue({
      error: null,
      hasLoaded: true,
      models: [
        {
          capabilities: { type: 'llm' },
          id: 'test-model',
          isEnabled: true,
          providerId: 'local',
        },
      ],
    } as unknown as ReturnType<typeof useModelRegistryStore>);

    rerender();

    expect(result.current).toEqual({ state: 'enabled' });
  });
});
