import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import {
  EMBEDDING_SET_UPDATED_EVENT,
  QUEUE_DRAINED_EVENT,
} from '@brainstrike/utils/browser-events';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDbModel, makeDbProvider } from '../settings/models/__tests__/catalog-test-harness';
import { SearchIndexingSettingsSection } from '../settings/system/search-indexing-settings-section';

const { findAllMock, getByIdMock, createWorkspaceMock } = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(),
  findAllMock: vi.fn(),
  getByIdMock: vi.fn(),
}));

const mockRepository = {
  findAll: findAllMock,
  getById: getByIdMock,
  getOrCreateSet: createWorkspaceMock,
};

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

vi.mock('@brainstrike/db', () => ({
  useEmbeddingSetsRepository: () => mockRepository,
}));
vi.mock('@brainstrike/db/react', () => ({
  useEmbeddingSetsRepository: () => mockRepository,
  usePGliteDatabase: () => null,
}));

// The granite catalog row migration 149 writes, as the model registry store loads it.
const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GRANITE_REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const graniteModel = makeDbModel({
  capabilities: {
    defaultDimension: 384,
    pooling: 'cls',
    prompts: { document: '', query: '' },
    type: 'embedding',
  },
  description: 'Recommended local model for semantic search.',
  id: GRANITE_ID,
  isEnabled: true,
  name: 'Granite Embedding Small R2',
  parameters: {
    execution: { wasm: 'q8', webgpu: 'fp16' },
    revision: GRANITE_REVISION,
    size: '~97MB',
  },
  providerId: 'local',
});

describe('SearchIndexingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePanelLayoutStore.setState({ activeTab: 'settings' });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      isLoading: false,
      models: [
        makeDbModel({
          capabilities: { defaultDimension: 768, type: 'embedding' },
          id: 'jinaai/jina-embeddings-v2-base-code',
          isEnabled: true,
          name: 'Jina Code',
          providerId: 'transformers',
        }),
        makeDbModel({
          capabilities: { defaultDimension: 768, type: 'embedding' },
          id: 'Xenova/bge-base-en-v1.5',
          isEnabled: true,
          name: 'BGE Base',
          providerId: 'transformers',
        }),
        makeDbModel({
          capabilities: { defaultDimension: 3072, type: 'embedding' },
          id: 'text-embedding-3-large',
          isEnabled: true,
          name: 'OpenAI Large',
          providerId: 'openai',
        }),
      ],
      providers: [
        makeDbProvider('transformers', 'Local models', 0),
        makeDbProvider('openai', 'OpenAI', 1),
      ],
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    findAllMock.mockResolvedValue([
      {
        createdAt: new Date().toISOString(),
        id: 'set-1',
        modelId: 'text-embedding-3-small',
        modelKey: 'openai::text-embedding-3-small',
        name: 'Managed Cache',
      },
    ]);
    getByIdMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      id: 'set-1',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Managed Cache',
    });
  });

  it('offers existing enabled embedding models across collection providers instead of a MiniLM allowlist', async () => {
    useModelRegistryStore.setState({
      hasLoaded: true,
      isLoading: false,
      models: [
        makeDbModel({
          capabilities: { defaultDimension: 768, type: 'embedding' },
          id: 'jinaai/jina-embeddings-v2-base-code',
          isEnabled: true,
          name: 'Jina Code',
          providerId: 'transformers',
        }),
        makeDbModel({
          capabilities: { defaultDimension: 1024, type: 'embedding' },
          id: 'Xenova/bge-large-en-v1.5',
          isEnabled: true,
          name: 'BGE Large',
          providerId: 'transformers',
        }),
        makeDbModel({
          capabilities: { defaultDimension: 3072, type: 'embedding' },
          id: 'text-embedding-3-large',
          isEnabled: true,
          name: 'OpenAI Large',
          providerId: 'openai',
        }),
        makeDbModel({
          capabilities: { defaultDimension: 1536, type: 'embedding' },
          id: 'disabled-model',
          isEnabled: false,
          name: 'Disabled model',
          providerId: 'openai',
        }),
      ],
      providers: [
        makeDbProvider('transformers', 'Local models', 0),
        makeDbProvider('openai', 'OpenAI', 1),
      ],
    });
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    expect(await screen.findByRole('option', { name: /Jina Code/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /BGE Large/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /OpenAI Large/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Disabled model/ })).toBeNull();
  });

  it('selects a remote collection with its actual dimensions without requiring local execution', async () => {
    findAllMock.mockResolvedValue([]);
    getByIdMock.mockResolvedValue(null);
    createWorkspaceMock.mockImplementation(
      async (modelKey: string, modelId: string, dimensions: number) => {
        const created = {
          createdAt: '2026-10-05',
          dimensions,
          id: 'remote',
          modelId,
          modelKey,
          name: 'Remote',
        };
        findAllMock.mockResolvedValue([created]);
        getByIdMock.mockResolvedValue(created);
        return created;
      }
    );
    useBackgroundIndexingPreferencesStore.getState().setNativeIndexMode('VECTOR');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /OpenAI Large/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use embedding model' }));
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe('remote')
    );
    expect(createWorkspaceMock).toHaveBeenCalledWith(
      'openai::text-embedding-3-large',
      'text-embedding-3-large',
      3072,
      'cosine',
      { name: 'Workspace Index (OpenAI Large)' }
    );
    expect(screen.queryByRole('combobox', { name: 'Local model execution' })).toBeNull();
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toBeNull();
  });

  it('creates and selects the canonical collection from empty native settings without choosing inference', async () => {
    findAllMock.mockResolvedValue([]);
    getByIdMock.mockResolvedValue(null);
    createWorkspaceMock.mockImplementation(async () => {
      const created = {
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 768,
        id: 'workspace-local',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
        name: 'Workspace Index',
      };
      findAllMock.mockResolvedValue([created]);
      getByIdMock.mockResolvedValue(created);
      return created;
    });
    useBackgroundIndexingPreferencesStore.getState().setNativeIndexMode('VECTOR');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Jina Code/ }));
    const setup = await screen.findByRole('button', { name: 'Use embedding model' });
    await waitFor(() => expect(setup.hasAttribute('disabled')).toBe(false));
    fireEvent.click(setup);
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        'workspace-local'
      )
    );
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Local model execution' }));
    expect(await screen.findByRole('option', { name: 'WASM · Q8' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'WASM · Q8' }));
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toMatchObject({
      device: 'wasm',
      dimensions: 768,
      dtype: 'q8',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
    });
  });

  it('selects a different model into its own collection and clears the old execution choice', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection({
      device: 'wasm',
      dimensions: 768,
      dtype: 'q8',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    });
    createWorkspaceMock.mockImplementation(async () => {
      const created = {
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 768,
        id: 'fused-collection',
        modelId: 'Xenova/bge-base-en-v1.5',
        modelKey: 'transformers::Xenova/bge-base-en-v1.5',
        name: 'Fused collection',
      };
      findAllMock.mockResolvedValue([created]);
      getByIdMock.mockResolvedValue(created);
      return created;
    });
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /BGE Base/ }));
    const setup = screen.getByRole('button', { name: 'Use embedding model' });
    await waitFor(() => expect(setup.hasAttribute('disabled')).toBe(false));
    fireEvent.click(setup);
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        'fused-collection'
      )
    );
    expect(createWorkspaceMock).toHaveBeenCalledWith(
      'transformers::Xenova/bge-base-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      768,
      'cosine',
      { name: 'Workspace Index (BGE Base)' }
    );
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toBeNull();
  });

  it('reuses the current matching model without duplicating the collection or clearing execution', async () => {
    const collection = {
      createdAt: '2026-10-05T00:00:00Z',
      dimensions: 768,
      distance: 'cosine',
      id: 'current-local',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
      name: 'My index',
    };
    findAllMock.mockResolvedValue([collection]);
    getByIdMock.mockResolvedValue(collection);
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId(collection.id);
    const selection = {
      device: 'wasm',
      dimensions: 768,
      dtype: 'q8',
      modelId: collection.modelId,
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    } as const;
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection(selection);
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Jina Code/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use embedding model' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use embedding model' }).hasAttribute('disabled')
      ).toBe(false)
    );
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      managedCollectionId: collection.id,
      nativeLocalSelection: selection,
    });
  });

  it('displays and preserves an existing generic model revision when choosing its execution format', async () => {
    const collection = {
      createdAt: '2026-10-05',
      dimensions: 768,
      id: 'pinned',
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
      name: 'Pinned Jina',
    };
    findAllMock.mockResolvedValue([collection]);
    getByIdMock.mockResolvedValue(collection);
    const preferences = useBackgroundIndexingPreferencesStore.getState();
    preferences.setManagedCollectionId(collection.id);
    preferences.setNativeIndexMode('VECTOR');
    preferences.setNativeLocalSelection({
      device: 'wasm',
      dimensions: 768,
      dtype: 'q8',
      modelId: collection.modelId,
      revision: 'a'.repeat(40),
    });
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    const picker = await screen.findByRole('combobox', { name: 'Local model execution' });
    expect(picker.textContent).toContain('WASM · Q8');
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'WASM · Q8' }));
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection?.revision).toBe(
      'a'.repeat(40)
    );
  });

  // BST-1993: the recommendation follows the embedding host's own WebGPU detection.
  const bgeSmallModel = makeDbModel({
    capabilities: {
      defaultDimension: 384,
      prompts: { document: '', query: 'Represent this sentence for searching relevant passages: ' },
      type: 'embedding',
    },
    id: 'Xenova/bge-small-en-v1.5',
    isEnabled: true,
    name: 'BGE Small',
    providerId: 'local',
  });
  function withLocalModels(): void {
    useModelRegistryStore.setState({
      models: [...useModelRegistryStore.getState().models, graniteModel, bgeSmallModel],
      providers: [
        ...useModelRegistryStore.getState().providers,
        makeDbProvider('local', 'Local', 2),
      ],
    });
  }
  function detection(result: Promise<{ available: boolean; reason: string }>) {
    return { webgpuAdapter: vi.fn(() => result) };
  }

  it('recommends granite on WebGPU when the embedding host detects an adapter (BST-1993)', async () => {
    withLocalModels();
    const localExecution = detection(
      Promise.resolve({ available: true, reason: 'WebGPU acceleration available (Apple M3)' })
    );
    render(
      <SearchIndexingSettingsSection
        localExecution={localExecution}
        nativeIndex={{ rebuild: vi.fn() }}
      />
    );
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(
      /^Recommended: Granite Embedding Small R2 \(WebGPU · FP16\)\./u
    );
    expect(localExecution.webgpuAdapter).toHaveBeenCalledOnce();
  });

  it('recommends BGE Small on WASM when the embedding host has no WebGPU (BST-1993)', async () => {
    withLocalModels();
    render(
      <SearchIndexingSettingsSection
        localExecution={detection(
          Promise.resolve({ available: false, reason: 'WASM fallback (WebGPU not available)' })
        )}
        nativeIndex={{ rebuild: vi.fn() }}
      />
    );
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/^Recommended: BGE Small \(WASM · Q8\)\./u);
  });

  it('recommends nothing while detection is pending, and shows a detection failure (BST-1993)', async () => {
    withLocalModels();
    let fail: (error: Error) => void = () => {};
    const pending = new Promise<{ available: boolean; reason: string }>((_resolve, reject) => {
      fail = reject;
    });
    render(
      <SearchIndexingSettingsSection
        localExecution={detection(pending)}
        nativeIndex={{ rebuild: vi.fn() }}
      />
    );
    expect(await screen.findByRole('button', { name: 'Use embedding model' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    await act(async () => {
      fail(new Error('WebGPU detection failed: GPU process crashed'));
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't detect WebGPU.");
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('retries failed WebGPU detection once when Settings reopens, but retains a successful result', async () => {
    withLocalModels();
    const webgpuAdapter = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw IPC request 17 failed'))
      .mockResolvedValue({ available: true, reason: 'WebGPU acceleration available' });
    render(
      <SearchIndexingSettingsSection
        localExecution={{ webgpuAdapter }}
        nativeIndex={{ rebuild: vi.fn() }}
      />
    );
    await screen.findByRole('alert');
    await act(async () => {
      usePanelLayoutStore.getState().setActiveTab('explorer');
      usePanelLayoutStore.getState().setActiveTab('settings');
    });
    await waitFor(() => expect(webgpuAdapter).toHaveBeenCalledTimes(2));
    await screen.findByRole('note');
    await act(async () => {
      usePanelLayoutStore.getState().setActiveTab('explorer');
      usePanelLayoutStore.getState().setActiveTab('settings');
    });
    expect(webgpuAdapter).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('describes the measured cost of a catalog WASM plan it does not recommend (BST-1993)', async () => {
    withLocalModels();
    const collection = {
      createdAt: '2026-10-12',
      dimensions: 384,
      id: 'granite-index',
      modelId: GRANITE_ID,
      modelKey: `local::${GRANITE_ID}`,
      name: 'Workspace Index (Granite Embedding Small R2)',
    };
    findAllMock.mockResolvedValue([collection]);
    getByIdMock.mockResolvedValue(collection);
    const preferences = useBackgroundIndexingPreferencesStore.getState();
    preferences.setManagedCollectionId(collection.id);
    preferences.setNativeIndexMode('VECTOR');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    const granite = findProviderDefinition('local')?.models.find(
      (model) => model.id === GRANITE_ID
    );
    const wasmNote = granite?.type === 'embedding' ? granite.executionNotes?.wasm : undefined;
    expect(wasmNote).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(wasmNote));
  });

  it('offers only granite catalog execution plans, pinned to its catalog revision (BST-1993)', async () => {
    useModelRegistryStore.setState({
      models: [...useModelRegistryStore.getState().models, graniteModel],
    });
    const collection = {
      createdAt: '2026-10-12',
      dimensions: 384,
      id: 'granite-index',
      modelId: GRANITE_ID,
      modelKey: `local::${GRANITE_ID}`,
      name: 'Workspace Index (Granite Embedding Small R2)',
    };
    findAllMock.mockResolvedValue([collection]);
    getByIdMock.mockResolvedValue(collection);
    const preferences = useBackgroundIndexingPreferencesStore.getState();
    preferences.setManagedCollectionId(collection.id);
    preferences.setNativeIndexMode('VECTOR');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Local model execution' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['WebGPU · FP16', 'WASM · Q8']);
    fireEvent.click(screen.getByRole('option', { name: 'WebGPU · FP16' }));
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toEqual({
      device: 'webgpu',
      dimensions: 384,
      dtype: 'fp16',
      modelId: GRANITE_ID,
      revision: GRANITE_REVISION,
    });
  });

  it('preserves newer selection even when it returns to the original collection during creation', async () => {
    let resolveCreation: ((value: object) => void) | undefined;
    createWorkspaceMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreation = resolve;
        })
    );
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Jina Code/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use embedding model' }));
    await waitFor(() => expect(createWorkspaceMock).toHaveBeenCalledTimes(1));
    act(() => {
      useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-2');
      useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    });
    await act(async () => {
      resolveCreation?.({
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 768,
        distance: 'cosine',
        id: 'new-local',
        modelId: 'jinaai/jina-embeddings-v2-base-code',
        modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
        name: 'New index',
      });
    });
    expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe('set-1');
  });

  it('keeps a failed collection setup visible without selecting or retrying it', async () => {
    findAllMock.mockResolvedValue([]);
    createWorkspaceMock.mockRejectedValue(new Error('Collection storage unavailable'));
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: /Jina Code/ }));
    const setup = await screen.findByRole('button', { name: 'Use embedding model' });
    await waitFor(() => expect(setup.hasAttribute('disabled')).toBe(false));
    fireEvent.click(setup);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Collection storage unavailable'
    );
    expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBeNull();
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
  });

  it('keeps derived rebuild busy until main settles and preserves saved choices', async () => {
    let finish: (() => void) | undefined;
    const rebuild = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    useBackgroundIndexingPreferencesStore.getState().setNativeIndexMode('TEXT');
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild search index' }));
    const busy = await screen.findByRole('button', { name: 'Rebuilding search index…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      managedCollectionId: 'set-1',
      nativeIndexMode: 'TEXT',
    });
    if (!finish) {
      throw new Error('Rebuild was not admitted.');
    }
    finish();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Rebuild search index' }).hasAttribute('disabled')
      ).toBe(false)
    );
  });

  it('shows a failed native rebuild without reporting completion', async () => {
    const rebuild = vi.fn(async () => {
      throw new Error('Native retirement did not settle.');
    });
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild search index' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Native retirement did not settle.'
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('renders the balanced policy by default and allows switching presets', async () => {
    render(<SearchIndexingSettingsSection />);

    expect(
      await screen.findByText(
        /skipping common dependency, generated, cache, lock, and minified artifacts/i
      )
    ).not.toBeNull();

    fireEvent.click(screen.getByLabelText(/indexing policy/i));
    fireEvent.click(screen.getByRole('option', { name: /full root/i }));

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().indexingPolicyPreset).toBe(
        'full-root'
      );
    });
    expect(screen.getByText(/including Python virtual environments/i)).not.toBeNull();
  });

  it('renders Workspace Index product copy instead of the old background-indexing label', async () => {
    render(<SearchIndexingSettingsSection />);

    expect((await screen.findAllByText('Workspace Index')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/workspace index/i)).not.toBeNull();
    expect(screen.queryByText(/^Background indexing$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Background indexing$/i)).toBeNull();
  });

  it('shows missing OpenAI key as a blocked Workspace Index setup state', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      blockedReason: 'missing-provider-key',
      lastError: 'OpenAI API key not configured.',
      managedCollectionName: 'Workspace Index',
      state: 'blocked',
    });

    render(<SearchIndexingSettingsSection />);

    expect(await screen.findByText('Waiting for OpenAI key')).not.toBeNull();
    expect(screen.getByText('OpenAI API key not configured.')).not.toBeNull();
  });

  it('names an unresponsive embedding model as the blocked state, with its cause (BST-2104)', async () => {
    const cause =
      'The embedding model stopped responding while it was loading. It sent no progress for 1 min (1 min after the batch started).';
    useWorkspaceCollectionSyncStatusStore.setState({
      blockedReason: 'embedding-host-unresponsive',
      lastError: cause,
      managedCollectionName: 'Workspace Index',
      state: 'blocked',
    });

    render(<SearchIndexingSettingsSection />);

    expect(await screen.findByText('Embedding model stopped')).not.toBeNull();
    expect(screen.getByText(cause)).not.toBeNull();
  });

  it('shows "No root selected" (not Blocked) when unconfigured (BST-1335)', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      activeRootPath: null,
      lastError: null,
      managedCollectionName: 'Workspace Index',
      state: 'unconfigured',
    });

    render(<SearchIndexingSettingsSection />);

    expect(await screen.findByText('No root selected')).not.toBeNull();
    expect(screen.queryByText('Blocked')).toBeNull();
  });

  it('shows recovering status when reattaching to an in-flight background backfill', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      backfillRequestId: 'background-indexing-backfill:test',
      managedCollectionName: 'Managed Cache',
      state: 'recovering',
    });

    render(<SearchIndexingSettingsSection />);

    expect(await screen.findByText('Recovering in-flight backfill')).not.toBeNull();
  });

  it('toggles the manual pause control', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      managedCollectionName: 'Managed Cache',
      state: 'embedding',
    });

    render(<SearchIndexingSettingsSection />);

    const pauseButton = await screen.findByRole('button', {
      name: /pause workspace index/i,
    });
    fireEvent.click(pauseButton);

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(true);
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /resume workspace index/i,
      })
    );

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(false);
    });
  });

  it('shows the manual pause control when Workspace Index is idle and enabled', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      managedCollectionId: 'set-1',
    });
    useWorkspaceCollectionSyncStatusStore.setState({
      managedCollectionName: 'Managed Cache',
      state: 'idle',
    });

    render(<SearchIndexingSettingsSection />);

    await screen.findByRole('combobox', { name: /managed collection/i });
    expect(screen.getByRole('button', { name: /pause workspace index/i })).not.toBeNull();
  });

  it('keeps the resume control visible when Workspace Index is paused after a sync error', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      managedCollectionId: 'set-1',
      paused: true,
    });
    useWorkspaceCollectionSyncStatusStore.setState({
      lastError: 'Root folder not selected.',
      managedCollectionName: 'Workspace Index',
      state: 'error',
    });

    render(<SearchIndexingSettingsSection />);

    await screen.findByRole('combobox', { name: /managed collection/i });
    expect(screen.getByRole('button', { name: /resume workspace index/i })).not.toBeNull();
  });

  it('keeps the pause control visible when a bound Workspace Index has a sync error', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      managedCollectionId: 'set-1',
      paused: false,
    });
    useWorkspaceCollectionSyncStatusStore.setState({
      lastError: 'Root folder not selected.',
      managedCollectionName: 'Workspace Index',
      state: 'error',
    });

    render(<SearchIndexingSettingsSection />);

    await screen.findByRole('combobox', { name: /managed collection/i });
    expect(screen.getByRole('button', { name: /pause workspace index/i })).not.toBeNull();
  });

  it('preserves the managed collection through a transient empty collection list', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-1',
      mode: 'root-folder-cache',
    });
    findAllMock.mockResolvedValueOnce([]);
    getByIdMock.mockResolvedValueOnce({
      createdAt: new Date().toISOString(),
      id: 'set-1',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Managed Cache',
    });

    render(<SearchIndexingSettingsSection />);

    await waitFor(() => {
      expect(getByIdMock).toHaveBeenCalledWith('set-1');
    });
    expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe('set-1');
  });

  it('clears a stale managed collection selection only after repository lookup confirms it is missing', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      hasHydrated: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-stale',
      mode: 'root-folder-cache',
    });
    findAllMock.mockResolvedValueOnce([]);
    getByIdMock.mockResolvedValue(null);

    render(<SearchIndexingSettingsSection />);

    await waitFor(() => {
      expect(getByIdMock).toHaveBeenCalledWith('set-stale');
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBeNull();
    });
  });

  it('refreshes collection options on embedding set updates and queue drained events', async () => {
    render(<SearchIndexingSettingsSection />);

    await waitFor(() => {
      expect(findAllMock).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(
      new CustomEvent(EMBEDDING_SET_UPDATED_EVENT, {
        detail: { id: 'set-1', reason: 'updated' },
      })
    );
    await waitFor(() => {
      expect(findAllMock).toHaveBeenCalledTimes(2);
    });

    window.dispatchEvent(
      new CustomEvent(QUEUE_DRAINED_EVENT, {
        detail: { embeddingSetId: 'set-1', queue: 'embeddings' },
      })
    );
    await waitFor(() => {
      expect(findAllMock).toHaveBeenCalledTimes(3);
    });
  });
});
