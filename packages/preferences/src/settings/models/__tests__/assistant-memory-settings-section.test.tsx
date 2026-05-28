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
    providers: [
      { id: 'openai', name: 'OpenAI', icon: null, isEnabled: true, sortOrder: 1 },
      { id: 'anthropic', name: 'Anthropic', icon: null, isEnabled: true, sortOrder: 2 },
      { id: 'transformers', name: 'Local Models', icon: null, isEnabled: true, sortOrder: 3 },
      { id: 'openrouter', name: 'OpenRouter', icon: null, isEnabled: false, sortOrder: 4 },
      { id: 'cohere', name: 'Cohere', icon: null, isEnabled: true, sortOrder: 5 },
    ],
    models: [
      {
        id: 'gpt-5.2-chat-latest',
        providerId: 'openai',
        name: 'GPT-5.2 Chat',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'llm', streaming: true },
        parameters: null,
        sortOrder: 1,
      },
      {
        id: 'claude-haiku-4-5',
        providerId: 'anthropic',
        name: 'Claude Haiku 4.5',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'llm', streaming: true },
        parameters: null,
        sortOrder: 1,
      },
      {
        id: 'onnx-community/gemma-4-E2B-it-ONNX',
        providerId: 'transformers',
        name: 'Gemma 4 Built-in',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'llm', streaming: true },
        parameters: null,
        sortOrder: 1,
      },
      {
        id: 'openai/gpt-5.2',
        providerId: 'openrouter',
        name: 'GPT-5.2 via OpenRouter',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'llm', streaming: true },
        parameters: null,
        sortOrder: 1,
      },
      {
        id: 'text-embedding-3-small',
        providerId: 'openai',
        name: 'Text Embedding 3 Small',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'embedding', defaultDimension: 1536 },
        parameters: null,
        sortOrder: 2,
      },
      {
        id: 'embed-english-v3.0',
        providerId: 'cohere',
        name: 'Cohere Embed English',
        description: null,
        tagline: null,
        bestFor: null,
        icon: null,
        isEnabled: true,
        capabilities: { type: 'embedding', defaultDimension: 1024 },
        parameters: null,
        sortOrder: 1,
      },
    ],
    hasLoaded: true,
    isLoading: false,
    error: null,
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
    expect(within(select).getByRole('option', { name: /GPT-5.2 Chat/i })).toBeInTheDocument();
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
      modelTarget: 'anthropic/claude-haiku-4-5',
      messageTokens: 18_000,
    });
  });

  it('shows semantic recall as disabled until explicitly enabled with an embedding model', async () => {
    const user = userEvent.setup();
    render(<AssistantMemorySettingsSection />);

    expect(screen.getByText(/Semantic recall is off/i)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /enable semantic recall/i }));

    expect(useAssistantMemoryPreferencesStore.getState().semanticRecall).toMatchObject({
      enabled: true,
      embeddingModelTarget: 'openai/text-embedding-3-small',
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
        enabled: true,
        embeddingModelTarget: 'cohere/embed-english-v3.0',
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
