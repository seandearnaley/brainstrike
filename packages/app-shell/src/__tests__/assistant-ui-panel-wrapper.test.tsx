import type { SupportedProvider } from '@brainstrike/agent/client';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/preferences';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';

// Track enabled models in a mutable Set for testing toggle functionality
const testEnabledModels = new Set<string>([
  'gpt-5.2', // OpenAI default
  'claude-sonnet-4-5', // Anthropic default
  'gemini-3-flash-preview', // Google default
  'openai/gpt-5.2', // OpenRouter default
]);

// Mock the model registry store - this is the source of truth for enabled models
vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
    useEnsureModelRegistry: vi.fn(),
    useModelRegistryStore: vi.fn((selector) => {
      const state = {
        models: [
          // OpenAI models
          {
            id: 'gpt-5.2',
            providerId: 'openai',
            isEnabled: testEnabledModels.has('gpt-5.2'),
            capabilities: { type: 'llm' },
          },
          // Anthropic models
          {
            id: 'claude-sonnet-4-5',
            providerId: 'anthropic',
            isEnabled: testEnabledModels.has('claude-sonnet-4-5'),
            capabilities: { type: 'llm' },
          },
          // Google models
          {
            id: 'gemini-3-flash-preview',
            providerId: 'google',
            isEnabled: testEnabledModels.has('gemini-3-flash-preview'),
            capabilities: { type: 'llm' },
          },
          // OpenRouter models
          {
            id: 'openai/gpt-5.2',
            providerId: 'openrouter',
            isEnabled: testEnabledModels.has('openai/gpt-5.2'),
            capabilities: { type: 'llm' },
          },
          {
            id: 'anthropic/claude-sonnet-4.5',
            providerId: 'openrouter',
            isEnabled: testEnabledModels.has('anthropic/claude-sonnet-4.5'),
            capabilities: { type: 'llm' },
          },
          {
            id: 'google/gemini-3-flash-preview',
            providerId: 'openrouter',
            isEnabled: testEnabledModels.has('google/gemini-3-flash-preview'),
            capabilities: { type: 'llm' },
          },
        ],
        hasLoaded: true,
        toggleModel: vi.fn((_db, modelId: string, enabled: boolean) => {
          if (enabled) {
            testEnabledModels.add(modelId);
          } else {
            testEnabledModels.delete(modelId);
          }
        }),
      };
      return selector ? selector(state) : state;
    }),
    useSecretsStore: vi.fn((selector) => {
      const state = { secretsVersion: 0 };
      return selector ? selector(state) : state;
    }),
    useVectorStatusUIStore: vi.fn((selector) => {
      const state = { activeEmbeddingSetId: null };
      return selector ? selector(state) : state;
    }),
  };
});

// Mock the DB hook
vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: vi.fn(() => ({})),
  useDbInitializing: vi.fn(() => false),
  useDbProviderError: vi.fn(() => null),
}));

vi.mock('@brainstrike/file-explorer-ui', () => {
  const store = (
    selector?: (state: { tokenBudget: number; currentFolderId: string | null }) => unknown
  ) => {
    const state = { tokenBudget: 100_000, currentFolderId: 'test-folder' };
    return selector ? selector(state) : state;
  };
  return {
    useSelectionManager: () => ({ effectiveSelection: new Set<string>() }),
    useFileExplorerStoreContext: () => store,
  };
});

// Mock the agent/client exports
vi.mock('@brainstrike/agent/client', () => {
  const PROVIDER_DEFINITIONS = {
    openai: {
      id: 'openai',
      displayName: 'OpenAI',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [{ id: 'gpt-5.2', type: 'llm', default: true, supportsStreaming: true }],
    },
    anthropic: {
      id: 'anthropic',
      displayName: 'Anthropic',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [{ id: 'claude-sonnet-4-5', type: 'llm', default: true, supportsStreaming: true }],
    },
    google: {
      id: 'google',
      displayName: 'Google AI Studio',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        { id: 'gemini-3-flash-preview', type: 'llm', default: true, supportsStreaming: true },
      ],
    },
    openrouter: {
      id: 'openrouter',
      displayName: 'OpenRouter',
      runtime: 'gateway',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [
        { id: 'openai/gpt-5.2', type: 'llm', default: true, supportsStreaming: true },
        { id: 'anthropic/claude-sonnet-4.5', type: 'llm', supportsStreaming: true },
        { id: 'google/gemini-3-flash-preview', type: 'llm', supportsStreaming: true },
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

  // Models that are enabled by default (only those with default: true)
  const PROVIDER_DEFAULT_ENABLED_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      const models = PROVIDER_DEFINITIONS[provider].models;
      const defaultModels = models
        .filter((model) => 'default' in model && model.default)
        .map((model) => model.id);
      acc[provider] = defaultModels;
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string[]>
  );

  const NATIVE_TOOL_DEFAULTS = {};

  return {
    getProviderDefaultModel: (provider: string) =>
      PROVIDER_DEFAULT_MODELS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderDisplayName: (provider: string) => {
      const definition = PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS];
      return definition?.displayName ?? provider;
    },
    getProviderModels: (provider: string) =>
      PROVIDER_MODELS[provider as keyof typeof PROVIDER_MODELS] ?? [],
    getProviderDefinition: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderModelDefinitions: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS]?.models ?? [],
    isSupportedProvider: (provider: string) =>
      SUPPORTED_PROVIDERS.includes(provider as keyof typeof PROVIDER_DEFINITIONS),
    supportsStandardEmbeddingDimension: (provider: string) => provider !== 'openrouter',
    listProviders: () => SUPPORTED_PROVIDERS.map((provider) => PROVIDER_DEFINITIONS[provider]),
    PROVIDER_DEFAULT_ENABLED_MODELS,
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
    NATIVE_TOOL_DEFAULTS,
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
      if (!compositeKey) {
        return '';
      }
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
          disabled={providers.length === 0}
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
          value={selectedProvider ?? ''}
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
          disabled={!selectedProvider || enabledModels.length === 0}
          onChange={(e) => {
            // Construct composite key when model changes
            if (selectedProvider) {
              onModelChange?.(`${selectedProvider}::${e.target.value}`);
            }
          }}
          value={modelName}
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
            <label htmlFor={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`} key={model.id}>
              <input
                checked={model.enabled}
                data-testid={`model-toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
                id={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
                onChange={(event) =>
                  onModelToggle?.(currentProvider?.id ?? '', model.id, event.target.checked)
                }
                type="checkbox"
              />
              {model.id}
            </label>
          ))}
        </div>
      </div>
    );
  },
}));

// Reset enabled models to defaults before each test
function resetTestEnabledModels() {
  testEnabledModels.clear();
  // Default enabled models (those with default: true in the mock)
  testEnabledModels.add('gpt-5.2'); // OpenAI default
  testEnabledModels.add('openai/gpt-5.2'); // OpenRouter default
  testEnabledModels.add('claude-sonnet-4-5'); // Anthropic default
  testEnabledModels.add('gemini-3-flash-preview'); // Google default
}

beforeEach(() => {
  resetTestEnabledModels();
  __resetAssistantPreferencesStoreForTests();
});

afterEach(() => {
  __resetAssistantPreferencesStoreForTests();
});

const renderAssistantPanel = async (providers: string[], afterRender?: () => Promise<void>) => {
  const renderResult = render(
    <AssistantUiPanelWrapper initialProviders={providers as SupportedProvider[]} />
  );

  if (afterRender) {
    await act(async () => {
      await afterRender();
    });
  }

  return renderResult;
};

describe('AssistantUiPanelWrapper', () => {
  test('auto-selects first provider and default model when none selected', async () => {
    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

          expect(providerSelect.value).toBe('openai');
          expect(modelSelect.value).toBe('gpt-5.2');
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows disabled reason when no providers available', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.'
          );
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        },
        { timeout: 3000 }
      )
    );
  });

  test('allows changing provider and auto-selects default model', async () => {
    const user = userEvent.setup();

    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Change provider to anthropic
    const providerSelect = screen.getByTestId('provider-select');
    await user.selectOptions(providerSelect, 'anthropic');

    // Wait for model to update and panel to remain enabled
    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).toBe('claude-sonnet-4-5');
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
    });
  });

  test('allows changing model for selected provider', async () => {
    const user = userEvent.setup();

    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.5');

    await renderAssistantPanel(['openrouter'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openrouter');
        },
        { timeout: 3000 }
      )
    );

    // Change model
    const modelSelect = screen.getByTestId('model-select');
    await user.selectOptions(modelSelect, 'anthropic/claude-sonnet-4.5');

    // Verify model changed in store
    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.getSelectedModel()).toBe('openrouter::anthropic/claude-sonnet-4.5');
      expect(state.modelsByProvider.openrouter).toBe('anthropic/claude-sonnet-4.5');
    });
  });

  test('preserves selected provider across re-renders', async () => {
    const renderResult = await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );
    const { rerender } = renderResult;

    // Manually select a different provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Re-render component
    await act(async () => {
      rerender(<AssistantUiPanelWrapper initialProviders={['openai', 'anthropic', 'google']} />);
    });

    // Selection should persist - wait for re-render to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });
  });

  test('starts with first provider when initially loaded', async () => {
    // Start with a single provider
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('anthropic');

          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect.value).toBe('claude-sonnet-4-5');

          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('model selector is disabled when no provider selected', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect).toBeDisabled();
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows correct models for each provider', async () => {
    await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Check OpenAI default model is available (only models with default: true are enabled)
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    const options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gpt-5.2'); // default model for openai

    // Switch to Google
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    // Wait for provider switch and model update to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');

      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      const options = Array.from(modelSelect.options).map((o) => o.value);
      expect(options).toContain('gemini-3-flash-preview'); // default model for google
      expect(options).not.toContain('gpt-5.2'); // openai model shouldn't be here
    });
  });

  test('persists provider and model selections in store', async () => {
    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.5');

    await renderAssistantPanel(['openai', 'openrouter'], () =>
      waitFor(() => {
        const state = useAssistantPreferencesStore.getState();
        expect(state.getSelectedProvider()).toBe('openai');
        expect(state.modelsByProvider.openai).toBe('gpt-5.2');
      })
    );

    // Change provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'openrouter');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.modelsByProvider.openrouter).toBe('openai/gpt-5.2');
    });

    // Change model (to the model we enabled above)
    await user.selectOptions(screen.getByTestId('model-select'), 'anthropic/claude-sonnet-4.5');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.modelsByProvider.openrouter).toBe('anthropic/claude-sonnet-4.5');
    });
  });

  test('disabling the active model calls toggleModel with correct args', async () => {
    const user = userEvent.setup();
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect((screen.getByTestId('provider-select') as HTMLSelectElement).value).toBe('openai');
      })
    );

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

    // Verify toggle is checked before clicking
    expect(toggle.checked).toBe(true);

    await user.click(toggle);

    // Verify the model was removed from the test enabled set (DB mock)
    expect(testEnabledModels.has(initialModelName)).toBe(false);
  });
});
