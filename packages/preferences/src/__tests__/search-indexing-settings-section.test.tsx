import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndexingSettingsSection } from '../settings/system/search-indexing-settings-section';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';
import { __resetWorkspaceCollectionSyncStatusStoreForTests } from '../stores/workspace-collection-sync-status-store';

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
});
