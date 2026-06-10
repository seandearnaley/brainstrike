import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  ChunkData,
  CollectionBrowserFilters,
  EmbeddingData,
  FileData,
  SemanticSearchResult,
} from '../collection-browser/types';
import {
  type CollectionSortState,
  type CollectionTreeInput,
  useCollectionTree,
} from '../collection-browser/use-collection-tree';

function makeFilters(overrides: Partial<CollectionBrowserFilters> = {}): CollectionBrowserFilters {
  return {
    searchQuery: '',
    nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
    embeddingStatus: 'all',
    searchMatchesOnly: false,
    ...overrides,
  };
}

describe('useCollectionTree', () => {
  it('builds file/chunk/embedding nodes with correct status and progress', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'app.tsx', path: '/repo/app.tsx', size: 123 }],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'hello world',
          tokenCount: 10,
          embeddingSetId: 'set-1',
        },
        {
          id: 'c2',
          fileRecordId: 'f1',
          chunkIndex: 1,
          content: 'hello line 10',
          tokenCount: 12,
          embedding: [0.1, 0.2, 0.3],
          embeddingSetId: 'set-1',
        },
      ],
      pendingChunkIds: new Set(['c1']),
    };

    const expandedIds = new Set<string>(['file-f1', 'chunk-c2']);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds,
        filters: makeFilters(),
      })
    );

    const ids = result.current.nodes.map((n) => n.id);
    expect(ids).toEqual(['file-f1', 'chunk-c1', 'chunk-c2', 'embedding-c2']);

    const fileNode = result.current.nodes[0];
    if (!fileNode || fileNode.type !== 'file') {
      throw new Error('expected file node');
    }
    const fileData = fileNode.data as unknown as FileData;
    expect(fileData.embeddingStatus).toBe('processing');
    expect(fileData.embeddingProgress).toBe(50);

    const chunk1 = result.current.nodes[1];
    if (!chunk1 || chunk1.type !== 'chunk') {
      throw new Error('expected chunk node');
    }
    const chunk1Data = chunk1.data as unknown as ChunkData;
    expect(chunk1Data.embeddingStatus).toBe('processing');

    const chunk2 = result.current.nodes[2];
    if (!chunk2 || chunk2.type !== 'chunk') {
      throw new Error('expected chunk node');
    }
    const chunk2Data = chunk2.data as unknown as ChunkData;
    expect(chunk2Data.embeddingStatus).toBe('complete');

    const embedding = result.current.nodes[3];
    if (!embedding || embedding.type !== 'embedding') {
      throw new Error('expected embedding node');
    }
    const embeddingData = embedding.data as unknown as EmbeddingData;
    expect(embeddingData.dimensions).toBe(3);
  });

  it('keeps parent nodes visible when filtered type is only present in children', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'app.tsx', path: '/repo/app.tsx', size: 123 }],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'needle in haystack',
          tokenCount: 10,
        },
      ],
    };

    const expandedIds = new Set<string>(['file-f1']);
    const filters = makeFilters({
      searchQuery: 'needle',
      nodeTypes: new Set(['chunk']),
    });

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds,
        filters,
      })
    );

    // Even though 'file' isn't in nodeTypes, file remains visible due to matching child.
    expect(result.current.nodes.map((n) => n.id)).toEqual(['file-f1', 'chunk-c1']);
    expect(result.current.searchMatchIds.has('chunk-c1')).toBe(true);
    expect(result.current.searchExpandIds.has('file-f1')).toBe(true);
  });

  it('matches searches against node IDs after stripping collection tree prefixes', () => {
    const data: CollectionTreeInput = {
      files: [
        { id: 'f1', name: 'app.tsx', path: '/repo/app.tsx', size: 123 },
        { id: 'f2', name: 'other.ts', path: '/repo/other.ts', size: 50 },
      ],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'target content',
          tokenCount: 10,
        },
        {
          id: 'c2',
          fileRecordId: 'f2',
          chunkIndex: 0,
          content: 'irrelevant',
          tokenCount: 5,
        },
      ],
    };
    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters({ searchQuery: 'c1' }),
      })
    );

    expect(result.current.nodes.map((n) => n.id)).toEqual(['file-f1', 'chunk-c1']);
    expect(result.current.searchMatchIds.has('chunk-c1')).toBe(true);
  });

  it('filters to semantic results and aggregates similarity score to parents', () => {
    const data: CollectionTreeInput = {
      files: [
        { id: 'f1', name: 'app.tsx', path: '/repo/app.tsx', size: 123 },
        { id: 'f2', name: 'other.ts', path: '/repo/other.ts', size: 50 },
      ],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'hello world',
          tokenCount: 10,
        },
        {
          id: 'c2',
          fileRecordId: 'f2',
          chunkIndex: 0,
          content: 'unrelated',
          tokenCount: 5,
        },
      ],
    };

    const semanticResults: SemanticSearchResult[] = [
      {
        nodeId: 'chunk-c1',
        chunkId: 'c1',
        fileRecordId: 'f1',
        similarity: 0.87,
        content: 'hello world',
        fileName: 'app.tsx',
        filePath: '/repo/app.tsx',
      },
    ];

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters(),
        semanticResults,
        filterToSemanticResults: true,
      })
    );

    expect(result.current.filteredCount).toBe(1);
    expect(result.current.nodes.map((n) => n.id)).toEqual(['file-f1', 'chunk-c1']);
    expect(result.current.semanticMatchIds.has('chunk-c1')).toBe(true);
    expect(result.current.semanticExpandIds.has('file-f1')).toBe(true);

    // Score is propagated from chunk to file.
    expect(result.current.similarityScores.get('chunk-c1')).toBe(0.87);
    expect(result.current.similarityScores.get('file-f1')).toBe(0.87);
  });

  it('uses persisted embedded chunk counts and import timestamps for file status', () => {
    const processedAt = '2026-06-09T12:00:00.000Z';
    const data: CollectionTreeInput = {
      files: [
        {
          id: 'f1',
          name: 'partial.ts',
          path: '/repo/partial.ts',
          size: 321,
          chunksCount: 4,
          embeddedChunksCount: 2,
          processedAt,
        },
      ],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'persisted count wins',
          tokenCount: 10,
        },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    const fileData = result.current.nodes[0]?.data as FileData | undefined;
    expect(fileData?.embeddingStatus).toBe('pending');
    expect(fileData?.embeddingProgress).toBe(50);
    expect(fileData?.importedAt).toEqual(new Date(processedAt));
  });

  it('filters getChildren to semantic result descendants only', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'matches.ts', path: '/repo/matches.ts', size: 100 }],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'first chunk',
          tokenCount: 10,
        },
        {
          id: 'c2',
          fileRecordId: 'f1',
          chunkIndex: 1,
          content: 'second chunk',
          tokenCount: 11,
        },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters(),
        semanticResults: [
          {
            nodeId: 'chunk-c2',
            chunkId: 'c2',
            fileRecordId: 'f1',
            similarity: 0.91,
            content: 'second chunk',
            fileName: 'matches.ts',
            filePath: '/repo/matches.ts',
          },
        ],
        filterToSemanticResults: true,
      })
    );

    expect(result.current.getChildren('file-f1').map((node) => node.id)).toEqual(['chunk-c2']);
    expect(result.current.nodes.map((node) => node.id)).toEqual(['file-f1', 'chunk-c2']);
  });

  it('sorts semantic matches by score when no explicit sort is provided', () => {
    const data: CollectionTreeInput = {
      files: [
        { id: 'f1', name: 'low.ts', path: '/repo/low.ts', size: 10 },
        { id: 'f2', name: 'high.ts', path: '/repo/high.ts', size: 20 },
      ],
      chunks: [
        { id: 'c1', fileRecordId: 'f1', chunkIndex: 0, content: 'low', tokenCount: 10 },
        { id: 'c2', fileRecordId: 'f2', chunkIndex: 0, content: 'high', tokenCount: 10 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        semanticResults: [
          {
            nodeId: 'chunk-c1',
            chunkId: 'c1',
            fileRecordId: 'f1',
            similarity: 0.2,
            content: 'low',
            fileName: 'low.ts',
            filePath: '/repo/low.ts',
          },
          {
            nodeId: 'chunk-c2',
            chunkId: 'c2',
            fileRecordId: 'f2',
            similarity: 0.9,
            content: 'high',
            fileName: 'high.ts',
            filePath: '/repo/high.ts',
          },
        ],
        filterToSemanticResults: false,
      })
    );

    expect(result.current.rootNodes.map((node) => node.id)).toEqual(['file-f2', 'file-f1']);
  });

  it('applies explicit score sorting to children with semantic scores', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'ranked.ts', path: '/repo/ranked.ts', size: 100 }],
      chunks: [
        { id: 'c1', fileRecordId: 'f1', chunkIndex: 0, content: 'middle', tokenCount: 10 },
        { id: 'c2', fileRecordId: 'f1', chunkIndex: 1, content: 'top', tokenCount: 11 },
        { id: 'c3', fileRecordId: 'f1', chunkIndex: 2, content: 'bottom', tokenCount: 12 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters(),
        semanticResults: [
          {
            nodeId: 'chunk-c1',
            chunkId: 'c1',
            fileRecordId: 'f1',
            similarity: 0.5,
            content: 'middle',
            fileName: 'ranked.ts',
            filePath: '/repo/ranked.ts',
          },
          {
            nodeId: 'chunk-c2',
            chunkId: 'c2',
            fileRecordId: 'f1',
            similarity: 0.9,
            content: 'top',
            fileName: 'ranked.ts',
            filePath: '/repo/ranked.ts',
          },
          {
            nodeId: 'chunk-c3',
            chunkId: 'c3',
            fileRecordId: 'f1',
            similarity: 0.1,
            content: 'bottom',
            fileName: 'ranked.ts',
            filePath: '/repo/ranked.ts',
          },
        ],
        filterToSemanticResults: false,
        sortState: { key: 'score', direction: 'asc' },
      })
    );

    expect(result.current.getChildren('file-f1').map((node) => node.id)).toEqual([
      'chunk-c3',
      'chunk-c1',
      'chunk-c2',
    ]);
  });

  it('sorts expanded chunks by token count and embedding status', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'sortable.ts', path: '/repo/sortable.ts', size: 100 }],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'largest complete chunk',
          tokenCount: 30,
          embedding: [0.1],
        },
        {
          id: 'c2',
          fileRecordId: 'f1',
          chunkIndex: 1,
          content: 'smallest processing chunk',
          tokenCount: 10,
        },
        {
          id: 'c3',
          fileRecordId: 'f1',
          chunkIndex: 2,
          content: 'middle unembedded chunk',
          tokenCount: 20,
        },
      ],
      pendingChunkIds: new Set(['c2']),
    };

    const { result, rerender } = renderHook(
      (sortState: CollectionSortState) =>
        useCollectionTree({
          data,
          expandedIds: new Set<string>(['file-f1']),
          filters: makeFilters(),
          sortState,
        }),
      { initialProps: { key: 'size', direction: 'desc' } as CollectionSortState }
    );

    expect(result.current.getChildren('file-f1').map((node) => node.id)).toEqual([
      'chunk-c1',
      'chunk-c3',
      'chunk-c2',
    ]);

    rerender({ key: 'status', direction: 'asc' });
    expect(result.current.getChildren('file-f1').map((node) => node.id)).toEqual([
      'chunk-c1',
      'chunk-c2',
      'chunk-c3',
    ]);

    rerender({ key: 'count', direction: 'asc' });
    expect(result.current.getChildren('file-f1').map((node) => node.id)).toEqual([
      'chunk-c2',
      'chunk-c3',
      'chunk-c1',
    ]);
  });

  it('searches chunk metadata derived from the parent file name', () => {
    const data: CollectionTreeInput = {
      files: [{ id: 'f1', name: 'metadata-name.ts', path: '/repo/metadata-name.ts', size: 100 }],
      chunks: [
        {
          id: 'c1',
          fileRecordId: 'f1',
          chunkIndex: 0,
          content: 'content without the query',
          tokenCount: 10,
        },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters({
          searchQuery: 'metadata-name',
          nodeTypes: new Set(['chunk']),
        }),
      })
    );

    expect(result.current.nodes.map((node) => node.id)).toEqual(['file-f1', 'chunk-c1']);
    expect(result.current.searchMatchIds.has('chunk-c1')).toBe(true);
  });
});
