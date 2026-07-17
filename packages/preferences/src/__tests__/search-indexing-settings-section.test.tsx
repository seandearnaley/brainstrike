import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndexingSettingsSection } from '../settings/system/search-indexing-settings-section';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '../stores/workspace-collection-sync-status-store';

const { findAllMock, getByIdMock } = vi.hoisted(() => ({
  findAllMock: vi.fn(),
  getByIdMock: vi.fn(),
}));

const mockRepository = {
  findAll: findAllMock,
  getById: getByIdMock,
};

vi.mock('@brainstrike/db', () => ({
  useEmbeddingSetsRepository: () => mockRepository,
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

  it('renders the balanced policy by default and allows switching presets', async () => {
    render(<SearchIndexingSettingsSection />);

    expect(
      await screen.findByText(/skipping common generated, cache, lock, and minified artifacts/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByLabelText(/indexing policy/i));
    fireEvent.click(screen.getByRole('option', { name: /full root/i }));

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().indexingPolicyPreset).toBe(
        'full-root'
      );
    });
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
      new CustomEvent('brainstrike:embedding-set-updated', {
        detail: { id: 'set-1', reason: 'updated' },
      })
    );
    await waitFor(() => {
      expect(findAllMock).toHaveBeenCalledTimes(2);
    });

    window.dispatchEvent(
      new CustomEvent('brainstrike:queue-drained', {
        detail: { embeddingSetId: 'set-1', queue: 'embeddings' },
      })
    );
    await waitFor(() => {
      expect(findAllMock).toHaveBeenCalledTimes(3);
    });
  });
});
