import '@testing-library/jest-dom/vitest';
import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDbModel, makeDbProvider } from '../settings/models/__tests__/catalog-test-harness';
import { SearchIndexSettingsSection } from '../settings/system/search-index-settings-section';

vi.mock('@brainstrike/app-state/hooks/use-local-runtime-embedding-model-catalog', () => ({
  useLocalRuntimeEmbeddingModelCatalog: () => ({
    catalog: null,
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('../../../ui/src/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
}));

const SEMANTIC: IndexConfig = {
  ...DEFAULT_INDEX_CONFIG,
  mode: 'semantic',
  model: { dimensions: 1536, local: null, modelKey: 'openai::text-embedding-3-small' },
};
// The granite catalog row as the model registry store loads it.
const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GRANITE_REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const update = vi.fn<(patch: unknown) => Promise<IndexConfig>>();

function show(config: IndexConfig) {
  useIndexConfigStore.setState({ state: { config, kind: 'ready' }, update });
  return render(<SearchIndexSettingsSection />);
}

describe('Search & Indexing', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockImplementation(
      async (patch) => ({ ...SEMANTIC, ...(patch as object) }) as IndexConfig
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      isLoading: false,
      models: [
        makeDbModel({
          capabilities: { defaultDimension: 1536, type: 'embedding' },
          id: 'text-embedding-3-small',
          isEnabled: true,
          name: 'OpenAI Small',
          providerId: 'openai',
        }),
        makeDbModel({
          capabilities: { type: 'embedding' },
          id: 'unmeasured-embedder',
          isEnabled: true,
          name: 'Unmeasured',
          providerId: 'openai',
        }),
        makeDbModel({
          capabilities: {
            defaultDimension: 384,
            pooling: 'cls',
            prompts: { document: '', query: '' },
            type: 'embedding',
          },
          id: GRANITE_ID,
          isEnabled: true,
          name: 'Granite Embedding Small R2',
          parameters: { execution: { wasm: 'q8', webgpu: 'fp16' }, revision: GRANITE_REVISION },
          providerId: 'local',
        }),
      ],
      providers: [makeDbProvider('openai', 'OpenAI', 0), makeDbProvider('local', 'On device', 1)],
    });
  });

  it('opens a fresh profile on text search with no model to choose', () => {
    show(DEFAULT_INDEX_CONFIG);
    expect(screen.getByRole('button', { name: /^Text/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Embedding model')).not.toBeInTheDocument();
    expect(screen.getByText(/Files over 500 KB are skipped\./)).toBeInTheDocument();
  });

  it('shows no mode while the settings are still loading', () => {
    useIndexConfigStore.setState({ state: { kind: 'loading' }, update });
    render(<SearchIndexSettingsSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading search index settings');
    expect(screen.queryByRole('button', { name: /^Off/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });

  it('changes nothing when the saved mode is chosen again', async () => {
    show(DEFAULT_INDEX_CONFIG);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Text/ }));
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('asks for a model before semantic search can be applied, and takes it back on Text', async () => {
    show(DEFAULT_INDEX_CONFIG);
    fireEvent.click(screen.getByRole('button', { name: /^Semantic/ }));
    expect(screen.getByRole('status', { name: 'Pending changes' })).toHaveTextContent(
      'Choose an embedding model first.'
    );
    expect(screen.getByRole('button', { name: 'Apply and re-index' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Text/ }));
    });
    expect(screen.queryByRole('status', { name: 'Pending changes' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('turns the index off at once', async () => {
    show(DEFAULT_INDEX_CONFIG);
    fireEvent.click(screen.getByRole('button', { name: /^Off/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ mode: 'off' }));
  });

  it('holds a custom chunk size until Apply, then re-indexes once', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Chunk size (tokens)'), { target: { value: '768' } });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Pending changes' })).toHaveTextContent(
      'Re-index needed'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and re-index' }));
    });
    expect(update).toHaveBeenCalledExactlyOnceWith({
      chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 },
    });
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Pending changes' })).not.toBeInTheDocument()
    );
  });

  it('keeps a refused change and says why', async () => {
    update.mockRejectedValueOnce(
      refusalError(
        'input',
        'index-config.refused',
        "The previous model's vectors could not be removed."
      )
    );
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and re-index' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The previous model's vectors could not be removed."
    );
    expect(screen.getByRole('status', { name: 'Pending changes' })).toBeInTheDocument();
  });

  it('forgets a refused Apply once the user edits or discards what it refused', async () => {
    const refusal = refusalError(
      'input',
      'index-config.refused',
      "The previous model's vectors could not be removed."
    );
    update.mockRejectedValueOnce(refusal).mockRejectedValueOnce(refusal);
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and re-index' }));
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Chunk size (tokens)'), { target: { value: '768' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and re-index' }));
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show a refused pause as a failed Apply', async () => {
    update.mockRejectedValueOnce(
      refusalError('input', 'index-config.refused', 'The saved search settings are damaged.')
    );
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause indexing' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The saved search settings are damaged.'
    );
    expect(
      within(screen.getByRole('status', { name: 'Pending changes' })).queryByRole('alert')
    ).not.toBeInTheDocument();
  });

  it('cannot apply a chunk size outside the limits', () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Chunk size (tokens)'), { target: { value: '4096' } });
    const size = screen.getByLabelText('Chunk size (tokens)');
    expect(size).toHaveAttribute('aria-invalid', 'true');
    expect(size).toHaveAccessibleDescription('Between 128 and 2048 tokens.');
    expect(screen.getByRole('button', { name: 'Apply and re-index' })).toBeDisabled();
  });

  it('pauses at once', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('button', { name: 'Pause indexing' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ paused: true }));
  });

  it('says why a refused pause did not happen', async () => {
    update.mockRejectedValueOnce(
      refusalError('input', 'index-config.refused', 'The saved search settings are damaged.')
    );
    show(SEMANTIC);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause indexing' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The saved search settings are damaged.'
    );
  });

  it('applies an on-device model only with the execution the user chose', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Granite Embedding Small R2/ }));
    expect(screen.getByRole('status', { name: 'Pending changes' })).toHaveTextContent(
      'Choose how to run the model first.'
    );
    expect(screen.getByRole('button', { name: 'Apply and re-index' })).toBeDisabled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Run it on' }));
    fireEvent.click(await screen.findByRole('option', { name: 'WASM · Q8' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and re-index' }));
    });
    expect(update).toHaveBeenCalledExactlyOnceWith({
      model: {
        dimensions: 384,
        local: { device: 'wasm', dtype: 'q8', revision: GRANITE_REVISION },
        modelKey: `local::${GRANITE_ID}`,
      },
    });
  });

  it('stages no model change when the saved model is chosen again', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Granite Embedding Small R2/ }));
    expect(screen.getByRole('status', { name: 'Pending changes' })).toHaveTextContent(
      'Model changes.'
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /OpenAI Small/ }));
    expect(screen.queryByRole('status', { name: 'Pending changes' })).not.toBeInTheDocument();
  });

  it('drops a model staged under Semantic when search switches to Text', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Granite Embedding Small R2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Text/ }));
    });
    expect(update).toHaveBeenCalledExactlyOnceWith({ mode: 'text' });
    const pending = screen.getByRole('status', { name: 'Pending changes' });
    expect(pending).toHaveTextContent('Chunking changes.');
    expect(pending).not.toHaveTextContent('Model changes.');
  });

  it('cannot choose a model without verified dimensions', async () => {
    show(SEMANTIC);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Unmeasured/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unmeasured has no verified embedding dimensions.'
    );
    expect(screen.queryByRole('status', { name: 'Pending changes' })).not.toBeInTheDocument();
  });

  it('says why the settings could not be read', () => {
    useIndexConfigStore.setState({
      state: { kind: 'failed', message: 'The search index settings could not be read.' },
      update: null,
    });
    render(<SearchIndexSettingsSection />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be read');
  });
});
