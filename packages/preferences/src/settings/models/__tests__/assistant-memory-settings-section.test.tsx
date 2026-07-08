import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantMemoryPreferencesStoreForTests,
  useAssistantMemoryPreferencesStore,
} from '../../../stores/assistant-memory-preferences-store';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../../../stores/model-registry-store';
import { AssistantMemorySettingsSection } from '../assistant-memory-settings-section';

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => ({})),
}));

vi.mock('../../../hooks/use-model-registry', () => ({
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
    ],
    providers: [
      { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 1 },
      { icon: null, id: 'anthropic', isEnabled: true, name: 'Anthropic', sortOrder: 2 },
      { icon: null, id: 'transformers', isEnabled: true, name: 'Local Models', sortOrder: 3 },
      { icon: null, id: 'openrouter', isEnabled: false, name: 'OpenRouter', sortOrder: 4 },
      { icon: null, id: 'cohere', isEnabled: true, name: 'Cohere', sortOrder: 5 },
    ],
  });
}

describe('AssistantMemorySettingsSection', () => {
  beforeEach(() => {
    __resetAssistantMemoryPreferencesStoreForTests();
    __resetModelRegistryStoreForTests();
    seedRegistry();
  });

  it('lists only enabled hosted LLM models for observational memory', () => {
    render(<AssistantMemorySettingsSection />);

    const select = screen.getByRole('combobox', { name: /observational memory model/i });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Claude Haiku 4.5/i })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Gemma 4 Built-in/i })).toBeNull();
    expect(within(select).queryByRole('option', { name: /OpenRouter/i })).toBeNull();
  });

  it('persists selected observational memory settings', async () => {
    const user = userEvent.setup();
    render(<AssistantMemorySettingsSection />);

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
    render(<AssistantMemorySettingsSection />);

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

  it('warns and allows disabling semantic recall when a persisted embedder is unsupported', async () => {
    const user = userEvent.setup();
    useAssistantMemoryPreferencesStore.setState((state) => ({
      semanticRecall: {
        ...state.semanticRecall,
        embeddingModelTarget: 'cohere/embed-english-v3.0',
        enabled: true,
      },
    }));

    render(<AssistantMemorySettingsSection />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Configured semantic recall embedder cohere/embed-english-v3.0 is not available'
    );
    expect(screen.getByRole('switch', { name: /enable semantic recall/i })).toBeEnabled();

    await user.click(screen.getByRole('switch', { name: /enable semantic recall/i }));

    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall.enabled).toBe(false);
  });
});
