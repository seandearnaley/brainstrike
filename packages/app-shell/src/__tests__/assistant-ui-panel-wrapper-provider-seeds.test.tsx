import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { loadTestLocalLlmBackend } from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper provider seeds', () => {
  test('merges desktop provider seeds with renderer-discovered local runtimes', async () => {
    const getAvailableProviders = vi.fn().mockResolvedValue(['local', 'ollama']);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery', seeds: ['openai', 'local'] }}>
        <AssistantUiPanelWrapper loadLocalLlmBackend={loadTestLocalLlmBackend} />
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

  test('keeps fixed Hosted Web providers authoritative without renderer discovery', async () => {
    const getAvailableProviders = vi.fn().mockResolvedValue(['local', 'ollama']);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
        <AssistantUiPanelWrapper
          fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
          loadLocalLlmBackend={loadTestLocalLlmBackend}
        />
      </AssistantProviderSourceProvider>
    );

    const providerSelect = (await screen.findByTestId('provider-select')) as HTMLSelectElement;
    expect([...providerSelect.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(['openai'])
    );
    expect([...providerSelect.options].map((option) => option.value)).not.toContain('ollama');
    expect(getAvailableProviders).not.toHaveBeenCalled();
  });

  test('surfaces renderer discovery failures instead of presenting seeded providers as healthy', async () => {
    const getAvailableProviders = vi.fn().mockRejectedValue(new Error('OS keychain is locked'));
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantProviderSourceProvider source={{ kind: 'discovery', seeds: ['openai'] }}>
        <AssistantUiPanelWrapper loadLocalLlmBackend={loadTestLocalLlmBackend} />
      </AssistantProviderSourceProvider>
    );

    expect(
      await screen.findByText('Could not refresh available providers: OS keychain is locked')
    ).toBeVisible();
  });
});
