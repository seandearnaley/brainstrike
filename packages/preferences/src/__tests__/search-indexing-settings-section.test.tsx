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

const { findAllMock } = vi.hoisted(() => ({
  findAllMock: vi.fn(),
}));

const mockRepository = {
  findAll: findAllMock,
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
        id: 'set-1',
        name: 'Managed Cache',
        modelId: 'text-embedding-3-small',
        modelKey: 'openai::text-embedding-3-small',
        createdAt: new Date().toISOString(),
      },
    ]);
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

  it('shows recovering status when reattaching to an in-flight background backfill', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'recovering',
      managedCollectionName: 'Managed Cache',
      backfillRequestId: 'background-indexing-backfill:test',
    });

    render(<SearchIndexingSettingsSection />);

    expect(await screen.findByText('Recovering in-flight backfill')).not.toBeNull();
  });

  it('toggles the manual pause control', async () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'embedding',
      managedCollectionName: 'Managed Cache',
    });

    render(<SearchIndexingSettingsSection />);

    const pauseButton = await screen.findByRole('button', {
      name: /pause background indexing/i,
    });
    fireEvent.click(pauseButton);

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(true);
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /resume background indexing/i,
      })
    );

    await waitFor(() => {
      expect(useBackgroundIndexingPreferencesStore.getState().paused).toBe(false);
    });
  });

  it('hides the manual pause control when background indexing is idle', async () => {
    useBackgroundIndexingPreferencesStore.setState({
      managedCollectionId: 'set-1',
    });
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'idle',
      managedCollectionName: 'Managed Cache',
    });

    render(<SearchIndexingSettingsSection />);

    await screen.findByRole('combobox', { name: /managed collection/i });
    expect(
      screen.queryByRole('button', {
        name: /pause background indexing/i,
      })
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /resume background indexing/i,
      })
    ).toBeNull();
  });
});
