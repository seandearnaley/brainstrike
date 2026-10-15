import './assistant-ui-panel-wrapper-test-support';
import {
  AvailableProviderDiscoveryError,
  useAssistantPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-preferences-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { hasDesktopLlmHostMock } from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper provider seeds', () => {
  afterEach(() => {
    hasDesktopLlmHostMock.mockReturnValue(false);
  });

  test('merges desktop provider seeds with renderer-discovered local runtimes', async () => {
    // A desktop host: the built-in local provider is offered here, so this
    // case sees the full merge rather than the web filter.
    hasDesktopLlmHostMock.mockReturnValue(true);
    const getAvailableProviders = vi.fn().mockResolvedValue(['local', 'ollama']);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery', seeds: ['openai', 'local'] }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );

    const providerSelect = (await screen.findByTestId('provider-select')) as HTMLSelectElement;
    await waitFor(() => {
      expect(getAvailableProviders).toHaveBeenCalledTimes(1);
      expect([...providerSelect.options].map((option) => option.value)).toEqual(
        expect.arrayContaining(['openai', 'local', 'ollama'])
      );
    });
  });

  test('preserves a persisted provider selection until Desktop discovery is complete', async () => {
    let resolveDiscovery: ((providers: SupportedProvider[]) => void) | undefined;
    const discovery = new Promise<SupportedProvider[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const getAvailableProviders = vi.fn(() => discovery);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
      selectedModel: 'openrouter::openai/gpt-5.2',
      selectedProvider: 'openrouter',
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery', seeds: ['anthropic'] }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );

    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(1));
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe(
      'openrouter::openai/gpt-5.2'
    );

    const completeDiscovery = resolveDiscovery;
    if (!completeDiscovery) {
      throw new Error('Provider discovery resolver was not initialized');
    }
    await act(async () => completeDiscovery(['anthropic', 'openrouter']));
    await waitFor(() => {
      expect(useAssistantPreferencesStore.getState().selectedModel).toBe(
        'openrouter::openai/gpt-5.2'
      );
    });
  });

  test('keeps fixed Hosted Web providers authoritative without renderer discovery', async () => {
    const getAvailableProviders = vi.fn().mockResolvedValue(['local', 'ollama']);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
        <AssistantUiPanelWrapper fixedProviderModels={{ openai: ['gpt-5.6-terra'] }} />
      </AssistantProviderSourceProvider>
    );

    const providerSelect = (await screen.findByTestId('provider-select')) as HTMLSelectElement;
    expect([...providerSelect.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(['openai'])
    );
    expect([...providerSelect.options].map((option) => option.value)).not.toContain('ollama');
    expect(getAvailableProviders).not.toHaveBeenCalled();
  });

  test('keeps a validated seed usable while surfacing a renderer discovery failure', async () => {
    const getAvailableProviders = vi.fn().mockRejectedValue(new Error('OS keychain is locked'));
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery', seeds: ['openai'] }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );

    expect(
      await screen.findByText('Could not refresh available providers: OS keychain is locked')
    ).toBeVisible();
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
  });

  test('disables the panel when discovery fails without any usable provider', async () => {
    const getAvailableProviders = vi.fn().mockRejectedValue(new Error('OS keychain is locked'));
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery' }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );

    expect(
      await screen.findByText('Could not refresh available providers: OS keychain is locked')
    ).toBeVisible();
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
  });

  test('reconciles against verified providers while a partial discovery failure stays visible', async () => {
    const getAvailableProviders = vi
      .fn()
      .mockRejectedValue(
        new AvailableProviderDiscoveryError(
          [new Error('ollama discovery failed: malformed bridge response')],
          ['anthropic']
        )
      );
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
      selectedModel: 'openrouter::openai/gpt-5.2',
      selectedProvider: 'openrouter',
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery' }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );

    expect(
      await screen.findByText(
        'Could not refresh available providers: Provider discovery failed: ollama discovery failed: malformed bridge response'
      )
    ).toBeVisible();
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
    await waitFor(() => {
      expect(useAssistantPreferencesStore.getState().getSelectedProvider()).toBe('anthropic');
      expect(useAssistantPreferencesStore.getState().selectedModel).toBe(
        'anthropic::claude-sonnet-4-6'
      );
    });
  });

  test('refreshes the mounted local model catalog when runtime settings change', async () => {
    const currentStore = useAssistantPreferencesStore.getState();
    const getLocalRuntimeModels = vi.fn(currentStore.getLocalRuntimeModels);
    const getLocalRuntimeStatuses = vi.fn(async () => ({
      lmstudio: {
        checkedAt: 10,
        message: 'not detected',
        state: 'unavailable' as const,
      },
      ollama: {
        checkedAt: 10,
        endpoint: 'http://127.0.0.1:11434/v1/models',
        latencyMs: 5,
        state: 'available' as const,
      },
    }));
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeModels,
      getLocalRuntimeStatuses,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['local'] }}>
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    );
    await waitFor(() => {
      expect(getLocalRuntimeStatuses).toHaveBeenCalledTimes(1);
      expect(getLocalRuntimeModels).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useAssistantPreferencesStore.getState().setProviderSettings('ollama', {
        localRuntimeBaseUrl: 'http://gpu.lan:11434',
      });
    });

    await waitFor(() => {
      expect(getLocalRuntimeStatuses).toHaveBeenCalledTimes(2);
      expect(getLocalRuntimeModels).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      useAssistantPreferencesStore.getState().setProviderSettings('openai', {
        reasoningEffort: 'high',
      });
      await Promise.resolve();
    });
    expect(getLocalRuntimeStatuses).toHaveBeenCalledTimes(2);
    expect(getLocalRuntimeModels).toHaveBeenCalledTimes(2);
  });
});
