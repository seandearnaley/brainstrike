import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionBrowserFilters, SemanticSearchResult } from '../collection-browser/types';
import { useCollectionBrowserState } from '../collection-browser/use-collection-browser-state';
import type {
  CollectionSortState,
  CollectionTreeInput,
} from '../collection-browser/use-collection-tree';

const allNodeTypes: CollectionBrowserFilters['nodeTypes'] = new Set([
  'collection',
  'file',
  'chunk',
  'embedding',
]);

const makeFilters = (
  overrides: Partial<CollectionBrowserFilters> = {}
): CollectionBrowserFilters => ({
  embeddingStatus: 'all',
  nodeTypes: new Set(allNodeTypes),
  searchMatchesOnly: false,
  searchQuery: '',
  ...overrides,
});

const testData: CollectionTreeInput = {
  chunks: [
    {
      chunkIndex: 0,
      content: 'needle in the app',
      embedding: [0.1, 0.2, 0.3],
      fileRecordId: 'f1',
      id: 'c1',
      tokenCount: 10,
    },
    {
      chunkIndex: 0,
      content: 'unrelated content',
      fileRecordId: 'f2',
      id: 'c2',
      tokenCount: 5,
    },
  ],
  files: [
    { id: 'f1', name: 'app.tsx', path: '/repo/app.tsx', size: 123 },
    { id: 'f2', name: 'other.ts', path: '/repo/other.ts', size: 50 },
  ],
};

describe('useCollectionBrowserState', () => {
  it('manages uncontrolled selection, expansion, and multi-select handlers', () => {
    const onSelect = vi.fn();
    const onMultiSelect = vi.fn();
    const onDoubleClick = vi.fn();
    const onContextMenu = vi.fn();
    const { result } = renderHook(() =>
      useCollectionBrowserState({
        data: testData,
        onContextMenu,
        onDoubleClick,
        onMultiSelect,
        onSelect,
      })
    );

    expect(result.current.nodes.map((node) => node.id)).toEqual(['file-f1', 'file-f2']);
    expect(result.current.selectedId).toBeNull();
    expect(result.current.columns).toBeNull();

    act(() => {
      result.current.handleSelect('file-f1');
    });

    expect(result.current.selectedId).toBe('file-f1');
    expect(onSelect).toHaveBeenCalledWith(
      'file-f1',
      'file',
      expect.objectContaining({ name: 'app.tsx', path: '/repo/app.tsx' })
    );

    act(() => {
      result.current.handleToggleExpand('file-f1');
    });

    expect(result.current.expandedIds.has('file-f1')).toBe(true);

    const selection = new Set(['file-f1', 'chunk-c1']);
    act(() => {
      result.current.handleMultiSelectChange(selection);
    });

    expect(result.current.multiSelectedIds).toBe(selection);
    expect(onMultiSelect).toHaveBeenCalledWith(selection);

    act(() => {
      result.current.handleClearSelection();
    });

    expect(result.current.multiSelectedIds.size).toBe(0);
    expect(onMultiSelect).toHaveBeenLastCalledWith(new Set());

    const node = result.current.nodes[0];
    if (!node) {
      throw new Error('expected a node');
    }
    const event = { preventDefault: vi.fn() } as unknown as React.MouseEvent;

    act(() => {
      result.current.handleDoubleClick(node.id, node);
      result.current.handleContextMenu(node.id, node, event);
    });

    expect(onDoubleClick).toHaveBeenCalledWith('file-f1', 'file', node.data);
    expect(onContextMenu).toHaveBeenCalledWith('file-f1', 'file', node.data, event);
    expect(result.current.nodeTypeMap.get('file-f1')).toBe('file');
  });

  it('maps controlled expansion and tree-table sort changes to collection state', () => {
    const expandedIds = new Set<string>();
    const onExpandedIdsChange = vi.fn();
    const onSortChange = vi.fn();
    const sortState: CollectionSortState = { direction: 'desc', key: 'count' };
    const { result } = renderHook(() =>
      useCollectionBrowserState({
        data: testData,
        expandedIds,
        onExpandedIdsChange,
        onSortChange,
        sortState,
      })
    );

    act(() => {
      result.current.handleToggleExpand('file-f1');
      result.current.handleTreeTableSortChange('meta', 'asc');
      result.current.handleTreeTableSortChange('score', 'desc');
      result.current.handleTreeTableSortChange('unknown', 'asc');
      result.current.handleTreeTableSortChange('name', null);
    });

    expect(result.current.treeTableSortState).toEqual({ columnId: 'meta', direction: 'desc' });
    expect(onExpandedIdsChange).toHaveBeenCalledWith(new Set(['file-f1']));
    expect(onSortChange).toHaveBeenNthCalledWith(1, { direction: 'asc', key: 'count' });
    expect(onSortChange).toHaveBeenNthCalledWith(2, { direction: 'desc', key: 'score' });
    expect(onSortChange).toHaveBeenNthCalledWith(3, null);
  });

  it('auto-expands search matches after the search query changes', async () => {
    const onExpandedIdsChange = vi.fn();
    const { rerender } = renderHook(
      ({ filters }: { filters: CollectionBrowserFilters }) =>
        useCollectionBrowserState({
          data: testData,
          expandedIds: new Set<string>(),
          filters,
          onExpandedIdsChange,
        }),
      {
        initialProps: { filters: makeFilters() },
      }
    );

    rerender({ filters: makeFilters({ searchQuery: 'needle' }) });

    await waitFor(() => {
      expect(onExpandedIdsChange).toHaveBeenCalledWith(new Set(['file-f1']));
    });
  });

  it('uses semantic matches for highlights and clears a hidden controlled selection', async () => {
    const onSelectedIdChange = vi.fn();
    const semanticResults: SemanticSearchResult[] = [
      {
        chunkId: 'c1',
        content: 'needle in the app',
        fileName: 'app.tsx',
        filePath: '/repo/app.tsx',
        fileRecordId: 'f1',
        nodeId: 'chunk-c1',
        similarity: 0.87,
      },
    ];

    const { result } = renderHook(() =>
      useCollectionBrowserState({
        data: testData,
        expandedIds: new Set(['file-f1']),
        onSelectedIdChange,
        searchMode: 'semantic',
        selectedId: 'file-f2',
        semanticResults,
      })
    );

    expect(result.current.isSemanticMode).toBe(true);
    expect(result.current.showScoreColumn).toBe(true);
    expect(result.current.hasSemanticResults).toBe(true);
    expect(result.current.highlightedIds).toBe(result.current.semanticMatchIds);
    expect(result.current.similarityScores.get('chunk-c1')).toBe(0.87);

    await waitFor(() => {
      expect(onSelectedIdChange).toHaveBeenCalledWith(null);
    });
  });
});
