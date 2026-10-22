import type { CollectionCatalogEntry } from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import { SearchCollectionPicker } from '../search-collection-picker';

const managedEntry: CollectionCatalogEntry = {
  counts: { chunks: 4, files: 2, unprocessedFiles: 0 },
  createdAt: '2026-10-13T12:00:00.000Z',
  dimensions: 384,
  distance: 'cosine',
  id: 'workspace-index',
  modelId: 'model',
  modelKey: 'local::model',
  name: 'Workspace Index',
  systemRole: 'workspace-index',
  vectors: { count: 4, kind: 'available' },
};

function serveCatalog(entries: readonly CollectionCatalogEntry[]): void {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: { snapshot: async () => ({ ok: true, value: entries }) },
  });
}

describe('SearchCollectionPicker readiness', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'collectionCatalog');
  });

  it('does not mark pending rows ready even when identical text exists elsewhere', async () => {
    serveCatalog([]);
    render(
      <>
        <h2>Workspace Index</h2>
        <SearchCollectionPicker />
      </>
    );

    expect(await screen.findAllByText('Workspace Index')).toHaveLength(2);
    expect(screen.queryByTestId('workspace-search-single-collection')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('marks only the resolved quiet label when other text has the same name', async () => {
    serveCatalog([managedEntry]);
    render(
      <>
        <h2>Workspace Index</h2>
        <SearchCollectionPicker />
      </>
    );

    expect(await screen.findByTestId('workspace-search-single-collection')).toHaveTextContent(
      'Workspace Index'
    );
    expect(screen.getAllByText('Workspace Index')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('lets the user explicitly select a sole imported collection', async () => {
    const { systemRole: _systemRole, ...managed } = managedEntry;
    const imported: CollectionCatalogEntry = { ...managed, id: 'imported', name: 'Imported set' };
    serveCatalog([imported]);
    const onCollectionChange = vi.fn();
    render(<SearchCollectionPicker onCollectionChange={onCollectionChange} />);

    const picker = await screen.findByRole('combobox', { name: 'Search collection' });
    expect(useWorkspaceSearchStore.getState().collectionId).toBeNull();
    expect(picker).toBeVisible();
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    const option = await screen.findByRole('option', { name: 'Imported set' });
    fireEvent.keyDown(option, { key: 'Enter' });

    expect(useWorkspaceSearchStore.getState().collectionId).toBe(imported.id);
    expect(onCollectionChange).toHaveBeenCalledWith(imported.id);
  });
});
