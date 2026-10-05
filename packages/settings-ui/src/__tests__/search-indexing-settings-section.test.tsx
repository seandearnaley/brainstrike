import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  EMBEDDING_SET_UPDATED_EVENT,
  QUEUE_DRAINED_EVENT,
} from '@brainstrike/utils/browser-events';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('@brainstrike/db', () => ({
  useEmbeddingSetsRepository: () => mockRepository,
}));
vi.mock('@brainstrike/db/react', () => ({
  useEmbeddingSetsRepository: () => mockRepository,
  usePGliteDatabase: () => null,
}));

describe('SearchIndexingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('creates and selects the canonical collection from empty native settings without choosing inference', async () => {
    findAllMock.mockResolvedValue([]);
    getByIdMock.mockResolvedValue(null);
    createWorkspaceMock.mockImplementation(async () => {
      const created = {
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 384,
        id: 'workspace-local',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
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
    fireEvent.click(await screen.findByRole('option', { name: 'MiniLM — CPU' }));
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
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
    });
  });

  it('selects a different model into its own collection and clears the old execution choice', async () => {
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection({
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    });
    createWorkspaceMock.mockImplementation(async () => {
      const created = {
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 384,
        id: 'fused-collection',
        modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
        modelKey: 'local::onnx-community/all-MiniLM-L6-v2-ONNX',
        name: 'Fused collection',
      };
      findAllMock.mockResolvedValue([created]);
      getByIdMock.mockResolvedValue(created);
      return created;
    });
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: 'MiniLM — WebGPU or CPU' }));
    const setup = screen.getByRole('button', { name: 'Use embedding model' });
    await waitFor(() => expect(setup.hasAttribute('disabled')).toBe(false));
    fireEvent.click(setup);
    await waitFor(() =>
      expect(useBackgroundIndexingPreferencesStore.getState().managedCollectionId).toBe(
        'fused-collection'
      )
    );
    expect(createWorkspaceMock).toHaveBeenCalledWith(
      'local::onnx-community/all-MiniLM-L6-v2-ONNX',
      'onnx-community/all-MiniLM-L6-v2-ONNX',
      384,
      'cosine',
      { name: 'Workspace Index (MiniLM — WebGPU or CPU)' }
    );
    expect(useBackgroundIndexingPreferencesStore.getState().nativeLocalSelection).toBeNull();
  });

  it('reuses the current matching model without duplicating the collection or clearing execution', async () => {
    const collection = {
      createdAt: '2026-10-05T00:00:00Z',
      dimensions: 384,
      distance: 'cosine',
      id: 'current-local',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      name: 'My index',
    };
    findAllMock.mockResolvedValue([collection]);
    getByIdMock.mockResolvedValue(collection);
    useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId(collection.id);
    const selection = {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: collection.modelId,
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    } as const;
    useBackgroundIndexingPreferencesStore.getState().setNativeLocalSelection(selection);
    render(<SearchIndexingSettingsSection nativeIndex={{ rebuild: vi.fn() }} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Embedding model' }));
    fireEvent.click(await screen.findByRole('option', { name: 'MiniLM — CPU' }));
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
    fireEvent.click(await screen.findByRole('option', { name: 'MiniLM — CPU' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use embedding model' }));
    await waitFor(() => expect(createWorkspaceMock).toHaveBeenCalledTimes(1));
    act(() => {
      useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-2');
      useBackgroundIndexingPreferencesStore.getState().setManagedCollectionId('set-1');
    });
    await act(async () => {
      resolveCreation?.({
        createdAt: '2026-10-05T00:00:00Z',
        dimensions: 384,
        distance: 'cosine',
        id: 'new-local',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
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
    fireEvent.click(await screen.findByRole('option', { name: 'MiniLM — CPU' }));
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
