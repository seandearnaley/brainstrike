import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/preferences';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';

// Mock the agent/client exports
vi.mock('@brainstrike/agent/client', () => {
  const PROVIDER_DEFINITIONS = {
    openai: {
      id: 'openai',
      displayName: 'OpenAI',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        { id: 'gpt-4o', type: 'llm', supportsStreaming: true },
        { id: 'gpt-4o-mini', type: 'llm', default: true, supportsStreaming: true },
        { id: 'gpt-4-turbo', type: 'llm', supportsStreaming: true },
        { id: 'gpt-3.5-turbo', type: 'llm', supportsStreaming: true },
      ],
    },
    anthropic: {
      id: 'anthropic',
      displayName: 'Anthropic',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [
        { id: 'claude-3-5-sonnet-latest', type: 'llm', supportsStreaming: true },
        { id: 'claude-3-5-haiku-latest', type: 'llm', default: true, supportsStreaming: true },
        { id: 'claude-3-opus-latest', type: 'llm', supportsStreaming: true },
      ],
    },
    google: {
      id: 'google',
      displayName: 'Google',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        { id: 'gemini-2.5-flash', type: 'llm', default: true, supportsStreaming: true },
        { id: 'gemini-2.0-pro', type: 'llm', supportsStreaming: true },
        { id: 'gemini-1.5-pro', type: 'llm', supportsStreaming: true },
      ],
    },
    openrouter: {
      id: 'openrouter',
      displayName: 'OpenRouter',
      runtime: 'gateway',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [
        { id: 'gpt-4o', type: 'llm', supportsStreaming: true },
        { id: 'gpt-4o-mini', type: 'llm', default: true, supportsStreaming: true },
        { id: 'claude-3-5-sonnet', type: 'llm', supportsStreaming: true },
      ],
    },
  } as const;

  const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as Array<
    keyof typeof PROVIDER_DEFINITIONS
  >;

  const PROVIDER_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      acc[provider] = PROVIDER_DEFINITIONS[provider].models.map((model) => model.id);
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string[]>
  );

  const PROVIDER_DEFAULT_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      const models = PROVIDER_DEFINITIONS[provider].models;
      const defaultModel = models.find((model) => 'default' in model && model.default) ?? models[0];
      acc[provider] = defaultModel.id;
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string>
  );

  return {
    getProviderDefaultModel: (provider: string) => {
      return PROVIDER_DEFAULT_MODELS[provider as keyof typeof PROVIDER_DEFINITIONS];
    },
    getProviderDisplayName: (provider: string) => {
      const definition = PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS];
      return definition?.displayName ?? provider;
    },
    getProviderModels: (provider: string) => {
      return PROVIDER_MODELS[provider as keyof typeof PROVIDER_MODELS] ?? [];
    },
    getProviderDefinition: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderModelDefinitions: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS]?.models ?? [],
    isSupportedProvider: (provider: string) =>
      SUPPORTED_PROVIDERS.includes(provider as keyof typeof PROVIDER_DEFINITIONS),
    supportsStandardEmbeddingDimension: (provider: string) => provider !== 'openrouter',
    listProviders: () => SUPPORTED_PROVIDERS.map((provider) => PROVIDER_DEFINITIONS[provider]),
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
  };
});

// Mock the AssistantUiPanel component
vi.mock('@brainstrike/ui/assistant-ui-panel', () => ({
  AssistantUiPanel: ({
    providerGroups = [],
    selectedProvider,
    selectedModel,
    onModelChange,
    onModelToggle,
    disabled,
    disabledReason,
  }: {
    providerGroups?: Array<{
      runtime: string;
      label: string;
      providers: Array<{
        id: string;
        name: string;
        models: Array<{ id: string; enabled: boolean }>;
      }>;
    }>;
    selectedProvider?: string;
    selectedModel?: string;
    onModelChange?: (compositeKey: string) => void;
    onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
    disabled?: boolean;
    disabledReason?: string;
  }) => {
    const providers = providerGroups?.flatMap((group) => group.providers) ?? [];
    const currentProvider = providers.find((p) => p.id === selectedProvider);
    const enabledModels = currentProvider?.models.filter((m) => m.enabled) ?? [];
    const allModels = currentProvider?.models ?? [];

    // Extract model name from composite key (format: "provider::model")
    const extractModelName = (compositeKey: string | undefined) => {
      if (!compositeKey) return '';
      const parts = compositeKey.split('::');
      return parts.length === 2 ? parts[1] : compositeKey;
    };

    const modelName = extractModelName(selectedModel);

    return (
      <div data-testid="assistant-ui-panel">
        <div data-testid="panel-disabled">{String(disabled)}</div>
        {disabledReason && <div data-testid="disabled-reason">{disabledReason}</div>}

        <select
          data-testid="provider-select"
          value={selectedProvider ?? ''}
          onChange={(e) => {
            // When provider changes, construct composite key with default model if enabled, otherwise first enabled model
            const newProvider = e.target.value;
            const provider = providers.find((p) => p.id === newProvider);
            if (provider) {
              const enabledModels = provider.models.filter((m) => m.enabled);
              const defaultModel = enabledModels.find((m) => 'default' in m && m.default);
              const modelToSelect = defaultModel ?? enabledModels[0];
              if (modelToSelect) {
                onModelChange?.(`${newProvider}::${modelToSelect.id}`);
              }
            }
          }}
          disabled={providers.length === 0}
        >
          <option value="">Select provider</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>

        <select
          data-testid="model-select"
          value={modelName}
          onChange={(e) => {
            // Construct composite key when model changes
            if (selectedProvider) {
              onModelChange?.(`${selectedProvider}::${e.target.value}`);
            }
          }}
          disabled={!selectedProvider || enabledModels.length === 0}
        >
          <option value="">Select model</option>
          {enabledModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id}
            </option>
          ))}
        </select>

        <div data-testid="model-toggles">
          {allModels.map((model) => (
            <label key={model.id} htmlFor={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`}>
              <input
                id={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
                type="checkbox"
                checked={model.enabled}
                onChange={(event) =>
                  onModelToggle?.(currentProvider?.id ?? '', model.id, event.target.checked)
                }
                data-testid={`model-toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
              />
              {model.id}
            </label>
          ))}
        </div>
      </div>
    );
  },
}));

// Mock window.secrets API
const mockSecretsList = vi.fn();
beforeEach(() => {
  Object.defineProperty(window, 'secrets', {
    value: { list: mockSecretsList },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  mockSecretsList.mockReset();
  __resetAssistantPreferencesStoreForTests();
  (window as { secrets?: unknown }).secrets = undefined;
});

describe('AssistantUiPanelWrapper', () => {
  test('auto-selects first provider and default model when none selected', async () => {
    // Mock available providers
    mockSecretsList.mockResolvedValue(['openai', 'anthropic']);

    render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection to occur - this waits for all async effects
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

        expect(providerSelect.value).toBe('openai');
        expect(modelSelect.value).toBe('gpt-4o-mini');
        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
      },
      { timeout: 3000 }
    );
  });

  test('shows disabled reason when no providers available', async () => {
    mockSecretsList.mockResolvedValue([]);

    render(<AssistantUiPanelWrapper />);

    await waitFor(
      () => {
        expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
          'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.'
        );
        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
      },
      { timeout: 3000 }
    );
  });

  test('allows changing provider and auto-selects default model', async () => {
    const user = userEvent.setup();
    mockSecretsList.mockResolvedValue(['openai', 'anthropic']);

    render(<AssistantUiPanelWrapper />);

    // Wait for initial auto-selection
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        expect(providerSelect.value).toBe('openai');
      },
      { timeout: 3000 }
    );

    // Change provider to anthropic
    const providerSelect = screen.getByTestId('provider-select');
    await user.selectOptions(providerSelect, 'anthropic');

    // Wait for model to update and panel to remain enabled
    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).toBe('claude-3-5-haiku-latest');
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
    });
  });

  test('allows changing model for selected provider', async () => {
    const user = userEvent.setup();
    mockSecretsList.mockResolvedValue(['openai']);

    render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        expect(providerSelect.value).toBe('openai');
      },
      { timeout: 3000 }
    );

    // Change model
    const modelSelect = screen.getByTestId('model-select');
    await user.selectOptions(modelSelect, 'gpt-4o');

    // Verify model changed in store
    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openai');
      expect(state.getSelectedModel()).toBe('openai::gpt-4o');
      expect(state.modelsByProvider.openai).toBe('gpt-4o');
    });
  });

  test('preserves selected provider across re-renders', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'anthropic', 'google']);

    const { rerender } = render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        expect(providerSelect.value).toBe('openai');
      },
      { timeout: 3000 }
    );

    // Manually select a different provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Re-render component
    rerender(<AssistantUiPanelWrapper />);

    // Selection should persist - wait for re-render to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });
  });

  test('starts with first provider when initially loaded', async () => {
    // Start with a single provider
    mockSecretsList.mockResolvedValue(['anthropic']);

    render(<AssistantUiPanelWrapper />);

    // Should auto-select the only available provider and update all state
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        expect(providerSelect.value).toBe('anthropic');

        const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(modelSelect.value).toBe('claude-3-5-haiku-latest');

        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
      },
      { timeout: 3000 }
    );
  });

  test('model selector is disabled when no provider selected', async () => {
    mockSecretsList.mockResolvedValue([]);

    render(<AssistantUiPanelWrapper />);

    await waitFor(
      () => {
        const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(modelSelect).toBeDisabled();
      },
      { timeout: 3000 }
    );
  });

  test('shows correct models for each provider', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'google']);

    render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection (openai)
    await waitFor(
      () => {
        const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
        expect(providerSelect.value).toBe('openai');
      },
      { timeout: 3000 }
    );

    // Check OpenAI models are available
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    const options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gpt-4o');
    expect(options).toContain('gpt-4o-mini');

    // Switch to Google
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    // Wait for provider switch and model update to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');

      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      const options = Array.from(modelSelect.options).map((o) => o.value);
      expect(options).toContain('gemini-2.5-flash');
      expect(options).toContain('gemini-2.0-pro');
      expect(options).not.toContain('gpt-4o');
    });
  });

  test('persists provider and model selections in store', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'anthropic']);

    render(<AssistantUiPanelWrapper />);

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openai');
      expect(state.modelsByProvider.openai).toBe('gpt-4o-mini');
    });

    // Change provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('anthropic');
      expect(state.modelsByProvider.anthropic).toBe('claude-3-5-haiku-latest');
    });

    // Change model
    await user.selectOptions(screen.getByTestId('model-select'), 'claude-3-5-sonnet-latest');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.modelsByProvider.anthropic).toBe('claude-3-5-sonnet-latest');
    });
  });

  test('disabling the active model through toggles selects a fallback', async () => {
    const user = userEvent.setup();
    mockSecretsList.mockResolvedValue(['openai']);

    render(<AssistantUiPanelWrapper />);

    await waitFor(() => {
      expect((screen.getByTestId('provider-select') as HTMLSelectElement).value).toBe('openai');
    });

    const initialCompositeModel = useAssistantPreferencesStore.getState().getSelectedModel();
    if (!initialCompositeModel) {
      throw new Error('expected initial model');
    }

    // Extract just the model name from composite key (format: "provider::model")
    const initialModelName = initialCompositeModel.split('::')[1];
    if (!initialModelName) {
      throw new Error('expected model name in composite key');
    }

    const toggle = screen.getByTestId(
      `model-toggle-openai-${initialModelName}`
    ) as HTMLInputElement;
    await user.click(toggle);

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.enabledModelsByProvider.openai).not.toContain(initialModelName);
      expect(state.getSelectedModel()).not.toBe(initialCompositeModel);
    });

    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).not.toBe(initialModelName);
    });
  });
});
