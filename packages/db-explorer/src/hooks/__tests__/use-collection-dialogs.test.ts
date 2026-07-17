import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollectionPickerCollection } from '../../components';
import { useCollectionDialogs } from '../use-collection-dialogs';

const mockCollection: CollectionPickerCollection = {
  category: null,
  chunkCount: 100,
  createdAt: new Date().toISOString(),
  description: 'Description 1',
  dimensions: 1536,
  distance: 'cosine',
  embeddingCount: 100,
  fileCount: 10,
  id: '1',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
  name: 'Collection 1',
  tags: null,
};

describe('useCollectionDialogs', () => {
  it('should initialize with closed dialogs and null selection', () => {
    const { result } = renderHook(() => useCollectionDialogs());

    expect(result.current.createCollectionOpen).toBe(false);
    expect(result.current.renameDialogOpen).toBe(false);
    expect(result.current.deleteDialogOpen).toBe(false);
    expect(result.current.selectedCollection).toBe(null);
  });

  it('should handle create collection dialog', () => {
    const { result } = renderHook(() => useCollectionDialogs());

    act(() => {
      result.current.handleCreateCollection();
    });
    expect(result.current.createCollectionOpen).toBe(true);

    act(() => {
      result.current.closeCreateDialog();
    });
    expect(result.current.createCollectionOpen).toBe(false);
  });

  it('should handle edit collection dialog', () => {
    const { result } = renderHook(() => useCollectionDialogs());

    act(() => {
      result.current.handleEditCollection(mockCollection);
    });
    expect(result.current.renameDialogOpen).toBe(true);
    expect(result.current.selectedCollection).toEqual(mockCollection);

    act(() => {
      result.current.closeRenameDialog();
    });
    expect(result.current.renameDialogOpen).toBe(false);
    expect(result.current.selectedCollection).toBe(null);
  });

  it('should handle delete collection dialog', () => {
    const { result } = renderHook(() => useCollectionDialogs());

    act(() => {
      result.current.handleDeleteCollection(mockCollection);
    });
    expect(result.current.deleteDialogOpen).toBe(true);
    expect(result.current.selectedCollection).toEqual(mockCollection);

    act(() => {
      result.current.closeDeleteDialog();
    });
    expect(result.current.deleteDialogOpen).toBe(false);
    expect(result.current.selectedCollection).toBe(null);
  });

  it('should not open edit/delete dialog if collection is null', () => {
    const { result } = renderHook(() => useCollectionDialogs());

    act(() => {
      result.current.handleEditCollection(null);
    });
    expect(result.current.renameDialogOpen).toBe(false);

    act(() => {
      result.current.handleDeleteCollection(null);
    });
    expect(result.current.deleteDialogOpen).toBe(false);
  });
});
