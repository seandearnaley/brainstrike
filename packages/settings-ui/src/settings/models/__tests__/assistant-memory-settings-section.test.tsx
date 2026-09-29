import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantMemoryPreferencesStoreForTests,
  useAssistantMemoryPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantMemorySettingsSection,
  type AssistantMemorySettingsSectionProps,
} from '../assistant-memory-settings-section';

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => ({})),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => ({})),
}));

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

function seedRegistry(): void {
  useModelRegistryStore.setState({
    error: null,
    hasLoaded: true,
    isLoading: false,
    models: [
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'gpt-5.4-mini',
        isEnabled: true,
        name: 'GPT-5.4 Mini',
        parameters: null,
        providerId: 'openai',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'claude-haiku-4-5',
        isEnabled: true,
        name: 'Claude Haiku 4.5',
        parameters: null,
        providerId: 'anthropic',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'onnx-community/gemma-4-E2B-it-ONNX',
        isEnabled: true,
        name: 'Gemma 4 Built-in',
        parameters: null,
        providerId: 'transformers',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'onnx-community/gemma-4-E2B-it-ONNX',
        isEnabled: true,
        name: 'Gemma 4 Local Observer',
        parameters: null,
        providerId: 'local',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'openai/gpt-5.2',
        isEnabled: true,
        name: 'GPT-5.2 via OpenRouter',
        parameters: null,
        providerId: 'openrouter',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { defaultDimension: 1536, type: 'embedding' },
        description: null,
        icon: null,
        id: 'text-embedding-3-small',
        isEnabled: true,
        name: 'Text Embedding 3 Small',
        parameters: null,
        providerId: 'openai',
        sortOrder: 2,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { defaultDimension: 1024, type: 'embedding' },
        description: null,
        icon: null,
        id: 'embed-english-v3.0',
        isEnabled: true,
        name: 'Cohere Embed English',
        parameters: null,
        providerId: 'cohere',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { defaultDimension: 384, type: 'embedding' },
        description: null,
        icon: null,
        id: 'Xenova/all-MiniLM-L6-v2',
        isEnabled: true,
        name: 'MiniLM Local Embedder',
        parameters: null,
        providerId: 'local',
        sortOrder: 2,
        tagline: null,
      },
    ],
    providers: [
      { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 1 },
      { icon: null, id: 'anthropic', isEnabled: true, name: 'Anthropic', sortOrder: 2 },
      { icon: null, id: 'transformers', isEnabled: true, name: 'Local Models', sortOrder: 3 },
      { icon: null, id: 'local', isEnabled: true, name: 'Built-in Local', sortOrder: 3 },
      { icon: null, id: 'openrouter', isEnabled: false, name: 'OpenRouter', sortOrder: 4 },
      { icon: null, id: 'cohere', isEnabled: true, name: 'Cohere', sortOrder: 5 },
    ],
  });
}

const hostedProviderKeySources = [
  { provider: 'openai', source: 'stored' },
  { provider: 'anthropic', source: 'stored' },
] as const;

function renderMemorySettings(
  providerKeySources: AssistantMemorySettingsSectionProps['providerKeySources'] = hostedProviderKeySources,
  assistantMemoryBackendAvailable = true
): ReturnType<typeof render> {
  return render(
    <AssistantMemorySettingsSection
      assistantMemoryBackendAvailable={assistantMemoryBackendAvailable}
      providerKeySources={providerKeySources}
    />
  );
}

describe('AssistantMemorySettingsSection', () => {
  beforeEach(() => {
    __resetAssistantMemoryPreferencesStoreForTests();
    __resetModelRegistryStoreForTests();
    seedRegistry();
  });

  it('lists only enabled hosted LLM models for observational memory', () => {
    renderMemorySettings();

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Claude Haiku 4.5/i })).toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: /Gemma 4 Local Observer/i })
    ).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Gemma 4 Built-in/i })).toBeNull();
    expect(within(select).queryByRole('option', { name: /OpenRouter/i })).toBeNull();
  });

  it('filters hosted observer models by key presence while retaining keyless local options', () => {
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Claude Haiku 4.5/i })).toBeNull();
    expect(
      within(select).getByRole('option', { name: /Gemma 4 Local Observer/i })
    ).toBeInTheDocument();
  });

  it('does not filter hosted memory models when credential provenance is unavailable', () => {
    render(<AssistantMemorySettingsSection assistantMemoryBackendAvailable={true} />);

    expect(
      within(screen.getByRole('combobox', { name: /observational memory model/i })).getByRole(
        'option',
        { name: /GPT-5.4 Mini/i }
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('combobox', { name: /semantic recall embedding model/i })).getByRole(
        'option',
        { name: /Text Embedding 3 Small/i }
      )
    ).toBeInTheDocument();
  });

  it('omits the local observer when the desktop memory backend is unavailable', () => {
    renderMemorySettings(hostedProviderKeySources, false);

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Gemma 4 Local Observer/i })).toBeNull();
  });

  it('does not claim credentials are missing before the model registry loads', () => {
    useModelRegistryStore.setState({ hasLoaded: false, models: [], providers: [] });

    renderMemorySettings([]);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables observation activation and alerts when the selected hosted provider has no key', () => {
    // User turned observations OFF and pinned an explicit model whose provider
    // has no key — re-activation stays blocked until the target is available.
    // (The default 'auto' target never blocks the toggle; see the BST-940 case.)
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: {
        ...state.observationalMemory,
        enabled: false,
        modelTarget: 'anthropic/claude-haiku-4-5',
      },
    }));

    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    expect(screen.getByRole('switch', { name: 'Enable observational memory' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Configure its API key in Settings → Providers'
    );
  });

  it('keeps the toggle usable on the default auto target and explains the privacy rule (BST-940)', () => {
    renderMemorySettings([{ provider: 'anthropic', source: 'stored' }]);

    const toggle = screen.getByRole('switch', { name: 'Enable observational memory' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: /observational memory model/i })).toHaveValue(
      'auto'
    );
    const note = screen.getByTestId('assistant-memory-auto-observer-note');
    // The privacy ruling: auto observes with the ACTIVE CHAT PROVIDER only,
    // never a different keyed provider, and local chats stay paused.
    expect(note).toHaveTextContent(/active chat provider only/i);
    expect(note).toHaveTextContent(/Local chats keep observations paused/i);
  });

  it('keeps the auto note and toggle stable for a keyless profile (waiting, not broken)', () => {
    renderMemorySettings([]);

    expect(screen.getByRole('switch', { name: 'Enable observational memory' })).toBeEnabled();
    expect(screen.getByTestId('assistant-memory-auto-observer-note')).toHaveTextContent(
      /active chat provider only/i
    );
  });

  it('persists selected observational memory settings', async () => {
    const user = userEvent.setup();
    renderMemorySettings();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /observational memory model/i }),
      'anthropic/claude-haiku-4-5'
    );
    await user.clear(screen.getByRole('spinbutton', { name: /observe messages after/i }));
    await user.type(screen.getByRole('spinbutton', { name: /observe messages after/i }), '18000');

    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory).toMatchObject({
      messageTokens: 18_000,
      modelTarget: 'anthropic/claude-haiku-4-5',
    });
  });

  it('shows semantic recall as disabled until explicitly enabled with an embedding model', async () => {
    const user = userEvent.setup();
    renderMemorySettings();

    expect(screen.getByText(/Semantic recall is off/i)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /enable semantic recall/i }));

    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall).toMatchObject({
      embeddingModelTarget: 'openai/text-embedding-3-small',
      enabled: true,
    });
    expect(
      within(
        screen.getByRole('combobox', { name: /semantic recall embedding model/i })
      ).queryByRole('option', { name: /Cohere Embed English/i })
    ).toBeNull();
  });

  it('filters hosted semantic embedders by key presence while retaining keyless local options', () => {
    renderMemorySettings([]);

    const select = screen.getByRole('combobox', {
      name: /semantic recall embedding model/i,
    });
    expect(within(select).queryByRole('option', { name: /Text Embedding 3 Small/i })).toBeNull();
    expect(
      within(select).getByRole('option', { name: /MiniLM Local Embedder/i })
    ).toBeInTheDocument();
  });

  it('disables semantic recall activation when its selected hosted embedder has no key', () => {
    renderMemorySettings([]);

    expect(screen.getByRole('switch', { name: /enable semantic recall/i })).toBeDisabled();
    expect(
      screen.getByText(
        /Configured semantic recall embedder openai\/text-embedding-3-small is not available/
      )
    ).toBeInTheDocument();
  });

  it('warns and allows disabling semantic recall when a persisted embedder is unsupported', async () => {
    const user = userEvent.setup();
    useAssistantMemoryPreferencesStore.setState((state) => ({
      semanticRecall: {
        ...state.semanticRecall,
        embeddingModelTarget: 'cohere/embed-english-v3.0',
        enabled: true,
      },
    }));

    renderMemorySettings();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Configured semantic recall embedder cohere/embed-english-v3.0 is not available'
    );
    expect(screen.getByRole('switch', { name: /enable semantic recall/i })).toBeEnabled();

    await user.click(screen.getByRole('switch', { name: /enable semantic recall/i }));

    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.enabled).toBe(false);
  });

  describe('manual observer egress disclosure', () => {
    const chooseObserver = (target: string) => {
      useAssistantMemoryPreferencesStore.setState((state) => ({
        observationalMemory: { ...state.observationalMemory, modelTarget: target },
      }));
    };

    it('states that a MANUAL target is not tied to the chat provider', () => {
      // Auto carries an enforced guarantee in its own copy — "the conversation
      // never reaches a provider that is not already receiving it" (BST-940).
      // A manual target has no such constraint and said nothing about egress,
      // so a reader of the auto note would assume it still held. Observed live
      // across two debug bundles: chat on openrouter, observer on
      // openai/gpt-5.6-luna.
      chooseObserver('openai/gpt-5.4-mini');
      renderMemorySettings();

      const note = screen.getByTestId('assistant-memory-manual-observer-note');
      expect(note).toHaveTextContent(/not tied to your chat provider/i);
      expect(note).toHaveTextContent(/reaches the observer's provider/i);
    });

    it('does NOT claim it on Auto, which cannot cross by construction', () => {
      chooseObserver('auto');
      renderMemorySettings();

      expect(screen.queryByTestId('assistant-memory-manual-observer-note')).toBeNull();
      expect(screen.getByTestId('assistant-memory-auto-observer-note')).toHaveTextContent(
        /never reaches a provider that is not already receiving it/i
      );
    });

    it('states it unconditionally, not per active thread', () => {
      // The observer target is GLOBAL; the chat provider is per-thread
      // (`draftRuntimeByThreadId` wins over the global `selectedModel` in
      // assistant-ui-panel-wrapper). A disclosure keyed to whichever thread
      // happened to be active would go silent for every OTHER thread — wrong
      // in the direction that matters, since the setting governs all of them.
      // So it describes the setting, and does not read any provider at all.
      chooseObserver('anthropic/claude-haiku-4-5');
      renderMemorySettings();

      expect(screen.getByTestId('assistant-memory-manual-observer-note')).toHaveTextContent(
        /not tied to your chat provider/i
      );
    });

    it('exempts an on-device observer instead of pushing the user off it', () => {
      // `local` is a first-class manual target (OBSERVATIONAL_MEMORY_PROVIDER_IDS)
      // that runs in the hidden host with no API key and no egress. Copy that
      // lumped it in with hosted providers would describe a local observer as
      // sending the conversation somewhere, and nudge a privacy-conscious user
      // OFF the on-device option onto a hosted one — recommending more egress
      // in the name of less.
      chooseObserver('local/onnx-community/gemma-4');
      renderMemorySettings();

      const note = screen.getByTestId('assistant-memory-manual-observer-note');
      expect(note).toHaveTextContent(/local/i);
      expect(note).toHaveTextContent(/runs on this device and sends nothing/i);
    });
  });
});
