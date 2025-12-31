import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

beforeAll(() => {
  const elementPrototype = Element.prototype as unknown as {
    hasPointerCapture?: (pointerId: number) => boolean;
    scrollIntoView?: () => void;
  };
  elementPrototype.hasPointerCapture = () => false;
  elementPrototype.scrollIntoView = () => {};
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

describe('EmbeddingSettings', () => {
  beforeEach(() => {
    __resetEmbeddingPreferencesStoreForTests();
    __resetModelRegistryStoreForTests();
    const provider: DbProvider = {
      id: 'transformers',
      name: 'Local Models',
      icon: null,
      isEnabled: true,
      sortOrder: 0,
    };
    const model: DbModel = {
      id: 'jinaai/jina-embeddings-v2-base-code',
      providerId: 'transformers',
      name: 'Jina Code',
      description: 'Code-aware embeddings',
      tagline: null,
      bestFor: ['code'],
      icon: null,
      isEnabled: true,
      capabilities: { type: 'embedding', defaultDimension: 768 },
      parameters: { size: '~300MB' },
      sortOrder: 0,
    };

    useModelRegistryStore.setState({
      providers: [provider],
      models: [model],
      isLoading: false,
      error: null,
      hasLoaded: true,
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
