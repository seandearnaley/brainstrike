import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantMemoryPreferencesStoreForTests,
  useAssistantMemoryPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantMemorySettingsSection,
  type AssistantMemorySettingsSectionProps,
} from '../assistant-memory-settings-section';

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
        capabilities: { defaultDimension: 3072, type: 'embedding' },
        description: null,
        icon: null,
        id: 'gemini-embedding-2',
        isEnabled: true,
        name: 'Gemini Embedding 2',
        parameters: null,
        providerId: 'google',
        sortOrder: 3,
        tagline: null,
      },
    ],
    providers: [
      { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 1 },
      { icon: null, id: 'anthropic', isEnabled: true, name: 'Anthropic', sortOrder: 2 },
      { icon: null, id: 'openrouter', isEnabled: false, name: 'OpenRouter', sortOrder: 4 },
      { icon: null, id: 'cohere', isEnabled: true, name: 'Cohere', sortOrder: 5 },
      { icon: null, id: 'google', isEnabled: true, name: 'Google', sortOrder: 6 },
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

  it('lists only enabled LLM models for observational memory', () => {
    renderMemorySettings();

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Claude Haiku 4.5/i })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /OpenRouter/i })).toBeNull();
  });

  it('filters observer models by key presence', () => {
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Claude Haiku 4.5/i })).toBeNull();
  });

  it('does not filter memory models when credential provenance is unavailable', () => {
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

  // Observational memory needs the durable backend to record anything, so with
  // no backend there is no eligible observer AT ALL.
  it('offers no observer model when the memory backend is unavailable', () => {
    renderMemorySettings(hostedProviderKeySources, false);

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).queryByRole('option', { name: /GPT-5.4 Mini/i })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Claude Haiku 4.5/i })).toBeNull();
    // The 'auto' sentinel still renders, and the section's own unresolved
    // notice explains the wait: OM is never silently off.
    expect(within(select).getByRole('option', { name: /Auto —/i })).toBeInTheDocument();
  });

  it('does not claim credentials are missing before the model registry loads', () => {
    useModelRegistryStore.setState({ hasLoaded: false, models: [], providers: [] });

    renderMemorySettings([]);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables observation activation and alerts when the selected provider has no key', () => {
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
    // never a different keyed provider.
    expect(note).toHaveTextContent(/active chat provider only/i);
  });

  it('keeps the auto note and toggle stable for a profile with no keys (waiting, not broken)', () => {
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
    await user.tab();

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

  it('filters semantic embedders by key presence', () => {
    renderMemorySettings([{ provider: 'google', source: 'stored' }]);

    const select = screen.getByRole('combobox', {
      name: /semantic recall embedding model/i,
    });
    expect(within(select).queryByRole('option', { name: /Text Embedding 3 Small/i })).toBeNull();
    expect(within(select).getByRole('option', { name: /Gemini Embedding 2/i })).toBeInTheDocument();
  });

  it('disables semantic recall activation when its selected embedder has no key', () => {
    renderMemorySettings([]);

    expect(screen.getByRole('switch', { name: /enable semantic recall/i })).toBeDisabled();
    // Nothing uses the embedder while recall and vector observation retrieval are off.
    expect(screen.queryByText(/Configured semantic recall embedder/)).toBeNull();
  });

  it('alerts about an unavailable embedder only while recall or vector observation retrieval uses it', () => {
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: { ...state.observationalMemory, retrievalMode: 'vector' },
    }));
    const { unmount } = renderMemorySettings([]);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Configured semantic recall embedder openai/text-embedding-3-small is not available. Choose an enabled OpenAI or Google embedding model, or turn off semantic recall and semantic observation recall.'
    );
    unmount();
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: { ...state.observationalMemory, enabled: false },
    }));
    renderMemorySettings([]);
    expect(screen.queryByText(/Configured semantic recall embedder/)).toBeNull();
  });

  it('describes what a send does without an embedder', () => {
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: {
        ...state.observationalMemory,
        enabled: false,
        modelTarget: 'anthropic/claude-haiku-4-5',
      },
    }));
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const section = screen.getByTestId('assistant-memory-settings-section');
    expect(section).not.toHaveTextContent(/assistant startup fails/i);
    expect(screen.getByTestId('assistant-memory-retrieval-note')).toHaveTextContent(
      'Semantic observation recall embeds observations with the semantic recall embedding model, even with semantic recall turned off. Until that model is available, the composer stays disabled and says why.'
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Configure its API key in Settings → Providers, choose an observer whose provider has a key, or turn observations off.'
    );
  });

  describe('number inputs', () => {
    // An entry out of range is refused under its field when committed and saves
    // nothing; the old setters clamped it to the nearest bound and saved that.
    it.each([
      ['Observe messages after', '500', 'Enter a whole number of at least 1,000.'],
      ['Reflect observations after', '1500.5', 'Enter a whole number of at least 1,000.'],
      ['Semantic matches', '60', 'Enter a whole number from 1 to 50.'],
      ['Semantic matches', '', 'Enter a whole number from 1 to 50.'],
      ['Surrounding messages', '-1', 'Enter a whole number from 0 to 20.'],
      // Empty is not zero, even where zero is allowed.
      ['Surrounding messages', '', 'Enter a whole number from 0 to 20.'],
    ])('%s refuses %j visibly and saves nothing', async (name, typed, message) => {
      const user = userEvent.setup();
      const before = useAssistantMemoryPreferencesStore.getState();
      renderMemorySettings();

      const input = screen.getByRole('spinbutton', { name });
      await user.clear(input);
      if (typed) {
        await user.type(input, typed);
      }
      await user.keyboard('{Enter}');

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(message);
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      const after = useAssistantMemoryPreferencesStore.getState();
      expect(after.observationalMemory).toEqual(before.observationalMemory);
      expect(after.semanticRecall).toEqual(before.semanticRecall);
    });

    it('saves a valid value on blur, never the keystrokes on the way, and clears the error', async () => {
      const user = userEvent.setup();
      renderMemorySettings();
      const before = useAssistantMemoryPreferencesStore.getState().semanticRecall.topK;

      const input = screen.getByRole('spinbutton', { name: 'Semantic matches' });
      await user.clear(input);
      await user.type(input, '70');
      await user.keyboard('{Enter}');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      // Typing "70" passed through "7"; a draft is not a value.
      expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.topK).toBe(before);
      await user.clear(input);
      await user.type(input, '7');
      await user.tab();

      expect(input).not.toHaveAttribute('aria-invalid');
      expect(input).not.toHaveAccessibleDescription();
      expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.topK).toBe(7);
    });
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
  });

  // BST-2227: the host embeds one test text with the selected embedder.
  describe('Test embedder', () => {
    const PASSED = { dimensions: 1536, latencyMs: 212, modelId: 'openai::text-embedding-3-small' };

    function renderWithTest(
      testEmbedder: NonNullable<AssistantMemorySettingsSectionProps['testEmbedder']>,
      providerKeySources: AssistantMemorySettingsSectionProps['providerKeySources'] = hostedProviderKeySources
    ) {
      return render(
        <AssistantMemorySettingsSection
          assistantMemoryBackendAvailable={true}
          providerKeySources={providerKeySources}
          testEmbedder={testEmbedder}
        />
      );
    }

    it('tests the selected embedder with the saved settings and shows its result', async () => {
      const user = userEvent.setup();
      const testEmbedder = vi.fn(async () => PASSED);
      renderWithTest(testEmbedder);

      await user.click(screen.getByRole('button', { name: 'Test embedder' }));

      expect(await screen.findByTestId('assistant-memory-embedder-test-result')).toHaveTextContent(
        'openai::text-embedding-3-small embedded the test text in 212 ms: 1536 dimensions.'
      );
      expect(testEmbedder).toHaveBeenCalledWith(
        useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings()
      );
    });

    it('shows the embedder’s typed failure: its message, provider evidence, remedy and reference', async () => {
      const user = userEvent.setup();
      renderWithTest(async () => {
        throw new BoundaryFailureError(
          fault({
            category: 'authorization',
            code: 'memory.embedder-failed',
            correlationId: '6f1c2a34-7d2b-4c1e-9a55-0b1d2c3e4f50',
            message:
              'Memory embedder test failed because its embedding model (OpenAI text-embedding-3-small) failed: Embedding provider openai refused the request (HTTP 401).',
            providerEvidence: 'OpenAI returned HTTP 401.',
            remedy: 'Check the OpenAI API key in Settings → Providers.',
          })
        );
      });

      await user.click(screen.getByRole('button', { name: 'Test embedder' }));

      const failure = await screen.findByTestId('assistant-memory-embedder-test-failure');
      expect(failure).toHaveAttribute('role', 'alert');
      expect(failure).toHaveTextContent(
        'Memory embedder test failed because its embedding model (OpenAI text-embedding-3-small) failed: Embedding provider openai refused the request (HTTP 401).OpenAI returned HTTP 401.Check the OpenAI API key in Settings → Providers.Reference: 6f1c2a34-7d2b-4c1e-9a55-0b1d2c3e4f50'
      );
    });

    it('shows an untyped failure as the generic fault, never its raw text', async () => {
      const user = userEvent.setup();
      renderWithTest(async () => {
        throw new Error('raw transport detail');
      });

      await user.click(screen.getByRole('button', { name: 'Test embedder' }));

      expect(await screen.findByTestId('assistant-memory-embedder-test-failure')).toHaveTextContent(
        'Something went wrong. The details were recorded in the diagnostic log.'
      );
      expect(screen.queryByText(/raw transport detail/)).toBeNull();
    });

    it('hides a result once another embedder is selected', async () => {
      const user = userEvent.setup();
      renderWithTest(
        async () => PASSED,
        [...hostedProviderKeySources, { provider: 'google', source: 'stored' }]
      );
      await user.click(screen.getByRole('button', { name: 'Test embedder' }));
      await screen.findByTestId('assistant-memory-embedder-test-result');

      await user.selectOptions(
        screen.getByRole('combobox', { name: /semantic recall embedding model/i }),
        'google/gemini-embedding-2'
      );

      expect(screen.queryByTestId('assistant-memory-embedder-test-result')).toBeNull();
    });

    it('never lets a slower answer for an earlier embedder replace a newer result', async () => {
      const user = userEvent.setup();
      const earlier = Promise.withResolvers<typeof PASSED>();
      const testEmbedder = vi
        .fn<NonNullable<AssistantMemorySettingsSectionProps['testEmbedder']>>()
        .mockImplementationOnce(() => earlier.promise)
        .mockResolvedValueOnce({
          dimensions: 3072,
          latencyMs: 90,
          modelId: 'google::gemini-embedding-2',
        });
      renderWithTest(testEmbedder, [
        ...hostedProviderKeySources,
        { provider: 'google', source: 'stored' },
      ]);
      await user.click(screen.getByRole('button', { name: 'Test embedder' }));
      await user.selectOptions(
        screen.getByRole('combobox', { name: /semantic recall embedding model/i }),
        'google/gemini-embedding-2'
      );
      await user.click(screen.getByRole('button', { name: 'Test embedder' }));
      const result = await screen.findByTestId('assistant-memory-embedder-test-result');
      expect(result).toHaveTextContent('google::gemini-embedding-2');

      // The earlier embedder answers last; React applies whatever it settles.
      await act(async () => {
        earlier.resolve(PASSED);
        await earlier.promise;
      });

      expect(screen.getByTestId('assistant-memory-embedder-test-result')).toHaveTextContent(
        'google::gemini-embedding-2 embedded the test text in 90 ms: 3072 dimensions.'
      );
    });

    it('offers no test until an available embedder is selected and says why', () => {
      useAssistantMemoryPreferencesStore
        .getState()
        .setSemanticRecallEmbeddingModelTarget('cohere/embed-english-v3.0');
      renderWithTest(vi.fn());

      expect(screen.getByRole('button', { name: 'Test embedder' })).toBeDisabled();
      expect(screen.getByText('Select an embedding model to test it.')).toBeInTheDocument();
    });

    it('is absent where the host has no embedder test', () => {
      renderMemorySettings();

      expect(screen.queryByRole('button', { name: 'Test embedder' })).toBeNull();
    });
  });
});
