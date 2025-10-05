import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';

// Mock the agent/client exports
vi.mock('@brainstrike/agent/client', () => {
  const PROVIDER_DEFAULT_MODELS = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-2.5-flash',
    openrouter: 'gpt-4o-mini',
  } as const;

  const PROVIDER_MODELS = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
    google: ['gemini-2.5-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
    openrouter: ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet'],
  } as const;

  return {
    getProviderDefaultModel: (provider: string) => {
      type Provider = keyof typeof PROVIDER_DEFAULT_MODELS;
      return PROVIDER_DEFAULT_MODELS[provider as Provider];
    },
    getProviderDisplayName: (provider: string) => {
      const names: Record<string, string> = {
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
        openrouter: 'OpenRouter',
      };
      return names[provider] ?? provider;
    },
    getProviderModels: (provider: string) => {
      type Provider = keyof typeof PROVIDER_MODELS;
      return PROVIDER_MODELS[provider as Provider] ?? [];
    },
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
  };
});

// Mock the AssistantUiPanel component
vi.mock('@brainstrike/ui/assistant-ui-panel', () => ({
  AssistantUiPanel: ({
    providers,
    selectedProvider,
    selectedModel,
    onProviderChange,
    onModelChange,
    disabled,
    disabledReason,
  }: {
    providers: Array<{ id: string; name: string; models: readonly string[] }>;
    selectedProvider?: string;
    selectedModel?: string;
    onProviderChange?: (value: string) => void;
    onModelChange?: (value: string) => void;
    disabled?: boolean;
    disabledReason?: string;
  }) => (
    <div data-testid="assistant-ui-panel">
      <div data-testid="panel-disabled">{String(disabled)}</div>
      {disabledReason && <div data-testid="disabled-reason">{disabledReason}</div>}

      {/* Provider selector */}
      <select
        data-testid="provider-select"
        value={selectedProvider ?? ''}
        onChange={(e) => onProviderChange?.(e.target.value)}
        disabled={providers.length === 0}
      >
        <option value="">Select provider</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {/* Model selector */}
      <select
        data-testid="model-select"
        value={selectedModel ?? ''}
        onChange={(e) => onModelChange?.(e.target.value)}
        disabled={!selectedProvider}
      >
        <option value="">Select model</option>
        {providers
          .find((p) => p.id === selectedProvider)
          ?.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
      </select>
    </div>
  ),
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

    // Wait for auto-selection to occur
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('openai');
    });

    // Check that default model is also selected
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(modelSelect.value).toBe('gpt-4o-mini');

    // Panel should be enabled
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
  });

  test('shows disabled reason when no providers available', async () => {
    mockSecretsList.mockResolvedValue([]);

    render(<AssistantUiPanelWrapper />);

    await waitFor(() => {
      expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
        'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.'
      );
    });

    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
  });

  test('allows changing provider and auto-selects default model', async () => {
    const user = userEvent.setup();
    mockSecretsList.mockResolvedValue(['openai', 'anthropic']);

    render(<AssistantUiPanelWrapper />);

    // Wait for initial auto-selection
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('openai');
    });

    // Change provider to anthropic
    const providerSelect = screen.getByTestId('provider-select');
    await user.selectOptions(providerSelect, 'anthropic');

    // Wait for model to update
    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).toBe('claude-3-5-haiku-latest');
    });

    // Panel should remain enabled
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
  });

  test('allows changing model for selected provider', async () => {
    const user = userEvent.setup();
    mockSecretsList.mockResolvedValue(['openai']);

    render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('openai');
    });

    // Change model
    const modelSelect = screen.getByTestId('model-select');
    await user.selectOptions(modelSelect, 'gpt-4o');

    // Verify model changed in store
    await waitFor(() => {
      const { selectedProvider, modelsByProvider } = useAssistantPreferencesStore.getState();
      expect(selectedProvider).toBe('openai');
      expect(modelsByProvider.openai).toBe('gpt-4o');
    });
  });

  test('preserves selected provider across re-renders', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'anthropic', 'google']);

    const { rerender } = render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('openai');
    });

    // Manually select a different provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Re-render component
    rerender(<AssistantUiPanelWrapper />);

    // Selection should persist
    const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
    expect(providerSelect.value).toBe('google');
  });

  test('starts with first provider when initially loaded', async () => {
    // Start with a single provider
    mockSecretsList.mockResolvedValue(['anthropic']);

    render(<AssistantUiPanelWrapper />);

    // Should auto-select the only available provider
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('anthropic');
    });

    // Should also select the default model
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(modelSelect.value).toBe('claude-3-5-haiku-latest');

    // Panel should be enabled
    expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
  });

  test('model selector is disabled when no provider selected', async () => {
    mockSecretsList.mockResolvedValue([]);

    render(<AssistantUiPanelWrapper />);

    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect).toBeDisabled();
    });
  });

  test('shows correct models for each provider', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'google']);

    render(<AssistantUiPanelWrapper />);

    // Wait for auto-selection (openai)
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('openai');
    });

    // Check OpenAI models are available
    let modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    let options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gpt-4o');
    expect(options).toContain('gpt-4o-mini');

    // Switch to Google
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Check Google models are available
    modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gemini-2.5-flash');
    expect(options).toContain('gemini-2.0-pro');
    expect(options).not.toContain('gpt-4o');
  });

  test('persists provider and model selections in store', async () => {
    mockSecretsList.mockResolvedValue(['openai', 'anthropic']);

    render(<AssistantUiPanelWrapper />);

    await waitFor(() => {
      const { selectedProvider, modelsByProvider } = useAssistantPreferencesStore.getState();
      expect(selectedProvider).toBe('openai');
      expect(modelsByProvider.openai).toBe('gpt-4o-mini');
    });

    // Change provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');

    await waitFor(() => {
      const { selectedProvider, modelsByProvider } = useAssistantPreferencesStore.getState();
      expect(selectedProvider).toBe('anthropic');
      expect(modelsByProvider.anthropic).toBe('claude-3-5-haiku-latest');
    });

    // Change model
    await user.selectOptions(screen.getByTestId('model-select'), 'claude-3-5-sonnet-latest');

    await waitFor(() => {
      const { modelsByProvider } = useAssistantPreferencesStore.getState();
      expect(modelsByProvider.anthropic).toBe('claude-3-5-sonnet-latest');
    });
  });
});
