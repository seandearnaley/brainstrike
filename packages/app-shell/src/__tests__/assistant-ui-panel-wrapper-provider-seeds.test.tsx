import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { loadTestLocalLlmBackend } from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper provider seeds', () => {
  test('merges desktop provider seeds with renderer-discovered local runtimes', async () => {
    const getAvailableProviders = vi.fn().mockResolvedValue(['local', 'ollama']);
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getAvailableProviders,
    }));

    render(
      <AssistantUiPanelWrapper
        loadLocalLlmBackend={loadTestLocalLlmBackend}
        providerSeeds={['openai', 'local']}
      />
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
      <AssistantUiPanelWrapper
        fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
        initialProviders={['openai']}
        loadLocalLlmBackend={loadTestLocalLlmBackend}
      />
    );

    const providerSelect = (await screen.findByTestId('provider-select')) as HTMLSelectElement;
    expect([...providerSelect.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(['openai'])
    );
    expect([...providerSelect.options].map((option) => option.value)).not.toContain('ollama');
    expect(getAvailableProviders).not.toHaveBeenCalled();
  });
});
