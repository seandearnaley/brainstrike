import type { LocalRuntimeModelCatalogState } from '@brainstrike/assistant-contract/local-runtime';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingSettings } from '../embedding/embedding-settings-section';
import {
  __resetEmbeddingPreferencesStoreForTests,
  useEmbeddingPreferencesStore,
} from '../stores/embedding-preferences-store';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  type DbProvider,
  useModelRegistryStore,
} from '../stores/model-registry-store';

const { mockUseLocalRuntimeEmbeddingModelCatalog, runtimeCatalogWithOllamaEmbedding } = vi.hoisted(
  () => {
    interface RuntimeCatalogMap {
      lmstudio: LocalRuntimeModelCatalogState;
      ollama: LocalRuntimeModelCatalogState;
    }
    interface RuntimeCatalogHookResult {
      catalog: RuntimeCatalogMap | null;
      error: string | null;
      isLoading: boolean;
      refresh: () => Promise<void>;
    }
    const runtimeCatalog: {
      ollama: LocalRuntimeModelCatalogState;
      lmstudio: LocalRuntimeModelCatalogState;
    } = {
      lmstudio: {
        availability: {
          checkedAt: 120,
          endpoint: 'http://localhost:1234/v1/models',
          latencyMs: 8,
          state: 'available',
        },
        checkedAt: 120,
        endpoint: 'http://localhost:1234/v1/models',
        freshness: 'live',
        models: [],
        runtime: 'lmstudio',
        source: 'openai_v1_models',
        state: 'loaded_empty',
      },
      ollama: {
        availability: {
          checkedAt: 120,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 6,
          state: 'available',
        },
        checkedAt: 120,
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'live',
        models: [
          {
            capabilities: {
              embeddings: 'supported',
              llm: false,
              vision: 'unknown',
            },
            capabilitySource: 'inferred',
            dimensionsKnown: {
              endpoint: 'http://127.0.0.1:11434/v1/embeddings',
              state: 'known',
              values: [768],
              verifiedAt: 120,
            },
            displayName: 'Nomic Embed Text',
            endpoint: 'http://127.0.0.1:11434/v1/models',
            freshness: 'live',
            modelId: 'nomic-embed-text',
            modelKey: 'ollama::nomic-embed-text',
            providerId: 'ollama',
            runtime: 'ollama',
            source: 'openai_v1_models',
          },
        ],
        runtime: 'ollama',
        source: 'openai_v1_models',
        state: 'loaded_non_empty',
      },
    };

    return {
      mockUseLocalRuntimeEmbeddingModelCatalog: vi.fn<() => RuntimeCatalogHookResult>(() => ({
        catalog: null,
        error: null,
        isLoading: false,
        refresh: vi.fn().mockResolvedValue(undefined),
      })),
      runtimeCatalogWithOllamaEmbedding: runtimeCatalog,
    };
  }
);

vi.mock('../hooks/use-local-runtime-embedding-model-catalog', () => ({
  useLocalRuntimeEmbeddingModelCatalog: mockUseLocalRuntimeEmbeddingModelCatalog,
}));

beforeAll(() => {
  const elementPrototype = Element.prototype as unknown as {
    hasPointerCapture?: (pointerId: number) => boolean;
    scrollIntoView?: () => void;
  };
  elementPrototype.hasPointerCapture = () => false;
  elementPrototype.scrollIntoView = () => {};
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: '',
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }),
      writable: true,
    });
  }
});

describe('EmbeddingSettings', () => {
  beforeEach(() => {
    __resetEmbeddingPreferencesStoreForTests();
    __resetModelRegistryStoreForTests();
    mockUseLocalRuntimeEmbeddingModelCatalog.mockReturnValue({
      catalog: null,
      error: null,
      isLoading: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const provider: DbProvider = {
      icon: null,
      id: 'transformers',
      isEnabled: true,
      name: 'Local Models',
      sortOrder: 0,
    };
    const model: DbModel = {
      bestFor: ['code'],
      capabilities: { defaultDimension: 768, type: 'embedding' },
      description: 'Code-aware embeddings',
      icon: null,
      id: 'jinaai/jina-embeddings-v2-base-code',
      isEnabled: true,
      name: 'Jina Code',
      parameters: { size: '~300MB' },
      providerId: 'transformers',
      sortOrder: 0,
      tagline: null,
    };

    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      isLoading: false,
      models: [model],
      providers: [provider],
    });
  });

  const renderComponent = () => render(<EmbeddingSettings />);

  it('shows the default local model selection', () => {
    renderComponent();

    const localModels = useEmbeddingPreferencesStore.getState().getEnabledModels('local');
    expect(localModels).toContain('jinaai/jina-embeddings-v2-base-code');
  });

  it('toggles model enablement', async () => {
    renderComponent();
    const toggle = await screen.findByTestId(
      'embedding-toggle-local-jinaai/jina-embeddings-v2-base-code'
    );

    // Toggle off
    await userEvent.click(toggle);
    expect(useEmbeddingPreferencesStore.getState().getEnabledModels('local')).not.toContain(
      'jinaai/jina-embeddings-v2-base-code'
    );
    // Toggle on
    await userEvent.click(toggle);
    expect(useEmbeddingPreferencesStore.getState().getEnabledModels('local')).toContain(
      'jinaai/jina-embeddings-v2-base-code'
    );
  });

  it('exposes language-specific code chunk defaults', () => {
    renderComponent();

    expect(screen.getByText('Code Chunking')).toBeTruthy();
    const tsRow = screen.getByTestId('code-chunk-row-typescript');
    const rustRow = screen.getByTestId('code-chunk-row-rust');
    expect(tsRow.textContent ?? '').toContain('512');
    expect(rustRow.textContent ?? '').toContain('Overlap 75');
  });

  it('filters models via search input', async () => {
    renderComponent();

    const input = screen.getByPlaceholderText('Search embedding models');
    expect(input.className).toContain('pl-10');
    expect(input.style.paddingLeft).toBe('2.5rem');
    expect(
      input.parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')?.style
        .left
    ).toBe('0.75rem');
    fireEvent.change(input, { target: { value: 'text-embedding-3-small' } });

    const openaiSection = screen.getByTestId('embedding-provider-openai');
    expect(openaiSection).toBeTruthy();
    expect(
      screen.queryByTestId('embedding-model-row-local-jinaai/jina-embeddings-v2-base-code')
    ).toBeNull();
  });

  it('enables a hosted model', async () => {
    renderComponent();

    const hostedToggle = await screen.findByTestId(
      'embedding-toggle-openai-text-embedding-3-small'
    );
    await userEvent.click(hostedToggle);

    const enabled = useEmbeddingPreferencesStore.getState().getEnabledModels('openai');
    expect(enabled).toContain('text-embedding-3-small');
  });

  it('renders discovered Ollama embedding models from runtime catalog', () => {
    mockUseLocalRuntimeEmbeddingModelCatalog.mockReturnValue({
      catalog: runtimeCatalogWithOllamaEmbedding,
      error: null,
      isLoading: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    renderComponent();

    expect(screen.getByTestId('embedding-provider-ollama')).toBeTruthy();
    expect(screen.getByTestId('embedding-model-row-ollama-nomic-embed-text')).toBeTruthy();
  });

  it('assigns runtime default badge after alphabetical sort', () => {
    const ollamaCatalog = runtimeCatalogWithOllamaEmbedding.ollama;
    if (ollamaCatalog.state !== 'loaded_non_empty') {
      throw new Error('expected loaded_non_empty ollama catalog');
    }
    const [baseModel] = ollamaCatalog.models;
    if (!baseModel) {
      throw new Error('expected at least one runtime model');
    }

    const runtimeCatalogWithOutOfOrderLabels: {
      ollama: LocalRuntimeModelCatalogState;
      lmstudio: LocalRuntimeModelCatalogState;
    } = {
      lmstudio: runtimeCatalogWithOllamaEmbedding.lmstudio,
      ollama: {
        ...ollamaCatalog,
        models: [
          {
            ...baseModel,
            displayName: 'Zeta Embedding',
            modelId: 'zeta-model',
            modelKey: 'ollama::zeta-model',
          },
          {
            ...baseModel,
            displayName: 'Alpha Embedding',
            modelId: 'alpha-model',
            modelKey: 'ollama::alpha-model',
          },
        ],
      },
    };

    mockUseLocalRuntimeEmbeddingModelCatalog.mockReturnValue({
      catalog: runtimeCatalogWithOutOfOrderLabels,
      error: null,
      isLoading: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    renderComponent();

    const alphaRow = screen.getByTestId('embedding-model-row-ollama-alpha-model');
    const zetaRow = screen.getByTestId('embedding-model-row-ollama-zeta-model');

    expect(within(alphaRow).getByText('Default')).toBeTruthy();
    expect(within(zetaRow).queryByText('Default')).toBeNull();
  });

  it('annotates stale cached runtime models with pending-dimension metadata', () => {
    const staleCatalog: {
      ollama: LocalRuntimeModelCatalogState;
      lmstudio: LocalRuntimeModelCatalogState;
    } = {
      lmstudio: runtimeCatalogWithOllamaEmbedding.lmstudio,
      ollama: {
        availability: {
          checkedAt: 120,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 6,
          state: 'available',
        },
        checkedAt: 120,
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'stale_cached',
        lastSuccessfulAt: 100,
        message: 'Using cached runtime model list',
        models: [
          {
            capabilities: {
              embeddings: 'needs_verification',
              llm: false,
              vision: 'unknown',
            },
            capabilitySource: 'inferred',
            dimensionsKnown: {
              state: 'needs_verification',
            },
            displayName: 'Pending Dimensions',
            endpoint: 'http://127.0.0.1:11434/v1/models',
            freshness: 'stale_cached',
            modelId: 'pending-model',
            modelKey: 'ollama::pending-model',
            providerId: 'ollama',
            runtime: 'ollama',
            source: 'openai_v1_models',
          },
        ],
        runtime: 'ollama',
        source: 'openai_v1_models',
        state: 'stale_cached',
      },
    };

    mockUseLocalRuntimeEmbeddingModelCatalog.mockReturnValue({
      catalog: staleCatalog,
      error: null,
      isLoading: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    renderComponent();

    const runtimeRow = screen.getByTestId('embedding-model-row-ollama-pending-model');
    expect(runtimeRow.textContent ?? '').toContain('Dimension pending verification');
    expect(runtimeRow.textContent ?? '').toContain('Using cached runtime model list');
  });

  describe('Quick Start Presets', () => {
    it('renders all three preset buttons', () => {
      renderComponent();

      expect(screen.getByTestId('preset-high-accuracy')).toBeTruthy();
      expect(screen.getByTestId('preset-cost-optimized')).toBeTruthy();
      expect(screen.getByTestId('preset-multilingual')).toBeTruthy();
    });

    it('applies high-accuracy preset (Voyage)', async () => {
      renderComponent();

      const presetButton = screen.getByTestId('preset-high-accuracy');
      await userEvent.click(presetButton);

      const state = useEmbeddingPreferencesStore.getState();
      expect(state.enabledModelsByProvider.voyage).toContain('voyage-3');
    });

    it('applies cost-optimized preset (OpenAI)', async () => {
      renderComponent();

      const presetButton = screen.getByTestId('preset-cost-optimized');
      await userEvent.click(presetButton);

      const state = useEmbeddingPreferencesStore.getState();
      expect(state.enabledModelsByProvider.openai).toContain('text-embedding-3-small');
    });

    it('applies multilingual preset (Cohere)', async () => {
      renderComponent();

      const presetButton = screen.getByTestId('preset-multilingual');
      await userEvent.click(presetButton);

      const state = useEmbeddingPreferencesStore.getState();
      expect(state.enabledModelsByProvider.cohere).toContain('embed-multilingual-v3.0');
    });

    it('enables model if not already enabled when applying preset', async () => {
      renderComponent();

      const stateBefore = useEmbeddingPreferencesStore.getState();
      expect(stateBefore.enabledModelsByProvider.voyage ?? []).not.toContain('voyage-3');

      const presetButton = screen.getByTestId('preset-high-accuracy');
      await userEvent.click(presetButton);

      const stateAfter = useEmbeddingPreferencesStore.getState();
      expect(stateAfter.enabledModelsByProvider.voyage).toContain('voyage-3');
      // No global selection should be set
    });

    it('switches between presets correctly', async () => {
      renderComponent();

      // First apply cost-optimized
      await userEvent.click(screen.getByTestId('preset-cost-optimized'));
      expect(useEmbeddingPreferencesStore.getState().getEnabledModels('openai')).toContain(
        'text-embedding-3-small'
      );

      // Then switch to multilingual
      await userEvent.click(screen.getByTestId('preset-multilingual'));
      expect(useEmbeddingPreferencesStore.getState().getEnabledModels('cohere')).toContain(
        'embed-multilingual-v3.0'
      );

      // Then switch to high-accuracy
      await userEvent.click(screen.getByTestId('preset-high-accuracy'));
      expect(useEmbeddingPreferencesStore.getState().getEnabledModels('voyage')).toContain(
        'voyage-3'
      );
    });
  });
});
