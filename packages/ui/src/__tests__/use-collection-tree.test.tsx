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
});
