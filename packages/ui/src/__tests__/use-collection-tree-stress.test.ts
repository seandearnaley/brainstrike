/**
 * Stress tests and edge-case tests for useCollectionTree hook.
 *
 * Covers large datasets, empty states, grouping, sorting, and
 * concurrent option changes (groupBy + sort + semantic results).
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  ChunkData,
  CollectionBrowserFilters,
  FileData,
  GroupByKey,
  SemanticSearchResult,
} from '../collection-browser/types';
import {
  type CollectionSortState,
  type CollectionTreeInput,
  useCollectionTree,
} from '../collection-browser/use-collection-tree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFilters(overrides: Partial<CollectionBrowserFilters> = {}): CollectionBrowserFilters {
  return {
    embeddingStatus: 'all',
    nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
    searchMatchesOnly: false,
    searchQuery: '',
    ...overrides,
  };
}

/**
 * Generate test data with a specified number of files, chunks per file,
 * and optionally embeddings per chunk.
 */
function generateTestData(
  fileCount: number,
  chunksPerFile: number,
  options: {
    embeddingsPerChunk?: number;
    fileNamePrefix?: string;
    fileExtension?: string;
    statuses?: Array<'none' | 'pending' | 'processing' | 'complete'>;
  } = {}
): CollectionTreeInput {
  const {
    fileNamePrefix = 'file',
    fileExtension = '.ts',
    embeddingsPerChunk = 0,
    statuses,
  } = options;

  const files: CollectionTreeInput['files'] = [];
  const chunks: CollectionTreeInput['chunks'] = [];
  const pendingChunkIds = new Set<string>();

  for (let f = 0; f < fileCount; f++) {
    const fileId = `f${f}`;
    const statusIdx = statuses ? f % statuses.length : -1;
    const status = statuses?.[statusIdx];

    files.push({
      id: fileId,
      name: `${fileNamePrefix}-${f}${fileExtension}`,
      path: `/repo/${fileNamePrefix}-${f}${fileExtension}`,
      size: 100 + f,
    });

    for (let c = 0; c < chunksPerFile; c++) {
      const chunkId = `c-${fileId}-${c}`;
      const hasEmbedding = embeddingsPerChunk > 0 || status === 'complete';

      chunks.push({
        chunkIndex: c,
        content: `Content of chunk ${c} in file ${f}`,
        fileRecordId: fileId,
        id: chunkId,
        tokenCount: 50 + c,
        ...(hasEmbedding ? { embedding: [0.1, 0.2, 0.3] } : {}),
      });

      if (status === 'pending' || status === 'processing') {
        pendingChunkIds.add(chunkId);
      }
    }
  }

  return { chunks, files, pendingChunkIds };
}

// ---------------------------------------------------------------------------
// Large dataset tests
// ---------------------------------------------------------------------------

describe('useCollectionTree — large datasets', () => {
  it('builds tree correctly for 1000 files x 10 chunks = 10K+ nodes', () => {
    const data = generateTestData(1000, 10);
    const expandedIds = new Set<string>();

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds,
        filters: makeFilters(),
      })
    );

    // 1000 root file nodes (collapsed)
    expect(result.current.nodes).toHaveLength(1000);
    // Total includes files + chunks
    expect(result.current.totalCount).toBe(1000 + 1000 * 10);
  });

  it('expands a single file to reveal its chunks among 1000 files', () => {
    const data = generateTestData(1000, 10);
    const expandedIds = new Set<string>(['file-f0']);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds,
        filters: makeFilters(),
      })
    );

    // 1000 files + 10 chunks from expanded file
    expect(result.current.nodes).toHaveLength(1010);
  });

  it('handles grouping with 50+ distinct group values', () => {
    // Create files with many different extensions to get 50+ groups
    const files: CollectionTreeInput['files'] = [];
    const chunks: CollectionTreeInput['chunks'] = [];

    for (let i = 0; i < 100; i++) {
      const ext = `.ext${i}`;
      files.push({
        id: `f${i}`,
        name: `file${i}${ext}`,
        path: `/repo/file${i}${ext}`,
        size: 100,
      });
      chunks.push({
        chunkIndex: 0,
        content: 'content',
        fileRecordId: `f${i}`,
        id: `c${i}`,
        tokenCount: 10,
      });
    }

    const { result } = renderHook(() =>
      useCollectionTree({
        data: { chunks, files },
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        groupBy: 'type',
      })
    );

    // Should have 100 group headers (one per unique extension)
    const groupNodes = result.current.nodes.filter((n) => n.type === 'group');
    expect(groupNodes).toHaveLength(100);
    expect(result.current.rootNodes).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Empty / minimal data edge cases
// ---------------------------------------------------------------------------

describe('useCollectionTree — empty and minimal data', () => {
  it('handles empty data (no files, no chunks)', () => {
    const { result } = renderHook(() =>
      useCollectionTree({
        data: { chunks: [], files: [] },
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.rootNodes).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
    expect(result.current.filteredCount).toBe(0);
  });

  it('handles single file with no chunks', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [{ id: 'f1', name: 'empty.ts', path: '/empty.ts', size: 0 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    expect(result.current.nodes).toHaveLength(1);
    const fileNode = result.current.nodes[0]!;
    expect(fileNode.hasChildren).toBe(false);
    const fileData = fileNode.data as FileData;
    expect(fileData.chunkCount).toBe(0);
    expect(fileData.embeddingStatus).toBe('none');
  });

  it('handles file with 500+ chunks', () => {
    const data = generateTestData(1, 500);
    const expandedIds = new Set<string>(['file-f0']);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds,
        filters: makeFilters(),
      })
    );

    // 1 file + 500 chunks
    expect(result.current.nodes).toHaveLength(501);
  });
});

// ---------------------------------------------------------------------------
// Grouping edge cases
// ---------------------------------------------------------------------------

describe('useCollectionTree — grouping', () => {
  it('groups all files into one group when all have same status', () => {
    const data = generateTestData(10, 1, { statuses: ['complete'] });

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        groupBy: 'status',
      })
    );

    // All files should be in one "Complete" group
    const groupNodes = result.current.nodes.filter((n) => n.type === 'group');
    expect(groupNodes).toHaveLength(1);
  });

  it('groupBy "none" returns flat file list as roots', () => {
    const data = generateTestData(5, 1);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        groupBy: 'none',
      })
    );

    // Should be 5 file nodes, no group headers
    expect(result.current.nodes).toHaveLength(5);
    expect(result.current.nodes.every((n) => n.type === 'file')).toBe(true);
  });

  it('groupBy "type" creates groups based on file extension', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [
        { id: 'f1', name: 'app.tsx', path: '/app.tsx', size: 100 },
        { id: 'f2', name: 'utils.ts', path: '/utils.ts', size: 50 },
        { id: 'f3', name: 'style.css', path: '/style.css', size: 30 },
        { id: 'f4', name: 'index.tsx', path: '/index.tsx', size: 80 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        groupBy: 'type',
      })
    );

    const groups = result.current.nodes.filter((n) => n.type === 'group');
    expect(groups).toHaveLength(3); // .tsx, .ts, .css
  });

  it('expanding a group reveals its file children at correct depth', () => {
    const data: CollectionTreeInput = {
      chunks: [{ chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 }],
      files: [
        { id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 },
        { id: 'f2', name: 'b.ts', path: '/b.ts', size: 100 },
      ],
    };

    const groupId = 'group-type-.ts';
    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>([groupId]),
        filters: makeFilters(),
        groupBy: 'type',
      })
    );

    // group + 2 files
    expect(result.current.nodes).toHaveLength(3);
    // Files should be at depth 1 under group
    const files = result.current.nodes.filter((n) => n.type === 'file');
    expect(files.every((f) => f.depth === 1)).toBe(true);
  });

  it('chunks are at depth 2 when grouping is active', () => {
    const data: CollectionTreeInput = {
      chunks: [{ chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 }],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    const groupId = 'group-type-.ts';
    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>([groupId, 'file-f1']),
        filters: makeFilters(),
        groupBy: 'type',
      })
    );

    const chunks = result.current.nodes.filter((n) => n.type === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unicode and special character file names
// ---------------------------------------------------------------------------

describe('useCollectionTree — special characters', () => {
  it('handles unicode file names', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [
        { id: 'f1', name: '\u6587\u4EF6.ts', path: '/\u6587\u4EF6.ts', size: 100 },
        {
          id: 'f2',
          name: '\u00E4\u00F6\u00FC\u00DF.ts',
          path: '/\u00E4\u00F6\u00FC\u00DF.ts',
          size: 200,
        },
        { id: 'f3', name: '\u{1F600}-emoji.tsx', path: '/\u{1F600}-emoji.tsx', size: 50 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    expect(result.current.nodes).toHaveLength(3);
    const names = result.current.nodes.map((n) => (n.data as FileData).name);
    expect(names).toContain('\u6587\u4EF6.ts');
    expect(names).toContain('\u00E4\u00F6\u00FC\u00DF.ts');
    expect(names).toContain('\u{1F600}-emoji.tsx');
  });

  it('handles very long file names (> 200 chars)', () => {
    const longName = `${'a'.repeat(250)}.ts`;
    const data: CollectionTreeInput = {
      chunks: [],
      files: [{ id: 'f1', name: longName, path: `/${longName}`, size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    expect(result.current.nodes).toHaveLength(1);
    expect((result.current.nodes[0]!.data as FileData).name).toBe(longName);
  });

  it('search finds unicode content', () => {
    const data: CollectionTreeInput = {
      chunks: [
        {
          chunkIndex: 0,
          content: '\u6587\u4EF6 content here',
          fileRecordId: 'f1',
          id: 'c1',
          tokenCount: 10,
        },
      ],
      files: [{ id: 'f1', name: '\u6587\u4EF6.ts', path: '/\u6587\u4EF6.ts', size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters({ searchQuery: '\u6587\u4EF6' }),
      })
    );

    expect(result.current.searchMatchIds.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sorting tests
// ---------------------------------------------------------------------------

describe('useCollectionTree — sorting', () => {
  it('sorts files by name ascending', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [
        { id: 'f3', name: 'charlie.ts', path: '/c', size: 1 },
        { id: 'f1', name: 'alpha.ts', path: '/a', size: 3 },
        { id: 'f2', name: 'bravo.ts', path: '/b', size: 2 },
      ],
    };

    const sortState: CollectionSortState = { direction: 'asc', key: 'name' };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        sortState,
      })
    );

    const names = result.current.nodes.map((n) => (n.data as FileData).name);
    expect(names).toEqual(['alpha.ts', 'bravo.ts', 'charlie.ts']);
  });

  it('sorts files by size descending', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [
        { id: 'f1', name: 'a.ts', path: '/a', size: 10 },
        { id: 'f2', name: 'b.ts', path: '/b', size: 30 },
        { id: 'f3', name: 'c.ts', path: '/c', size: 20 },
      ],
    };

    const sortState: CollectionSortState = { direction: 'desc', key: 'size' };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        sortState,
      })
    );

    const sizes = result.current.nodes.map((n) => (n.data as FileData).size);
    expect(sizes).toEqual([30, 20, 10]);
  });

  it('sorts chunks within expanded file by index', () => {
    const data: CollectionTreeInput = {
      chunks: [
        { chunkIndex: 2, content: 'z', fileRecordId: 'f1', id: 'c3', tokenCount: 5 },
        { chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 },
        { chunkIndex: 1, content: 'y', fileRecordId: 'f1', id: 'c2', tokenCount: 7 },
      ],
      files: [{ id: 'f1', name: 'a.ts', path: '/a', size: 10 }],
    };

    const sortState: CollectionSortState = { direction: 'asc', key: 'name' };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters(),
        sortState,
      })
    );

    const chunkIndices = result.current.nodes
      .filter((n) => n.type === 'chunk')
      .map((n) => (n.data as ChunkData).index);
    expect(chunkIndices).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent option changes
// ---------------------------------------------------------------------------

describe('useCollectionTree — concurrent option changes', () => {
  it('toggle groupBy while semantic results are present', () => {
    const data: CollectionTreeInput = {
      chunks: [
        { chunkIndex: 0, content: 'hit', fileRecordId: 'f1', id: 'c1', tokenCount: 10 },
        { chunkIndex: 0, content: 'miss', fileRecordId: 'f2', id: 'c2', tokenCount: 10 },
      ],
      files: [
        { id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 },
        { id: 'f2', name: 'b.tsx', path: '/b.tsx', size: 200 },
      ],
    };

    const semanticResults: SemanticSearchResult[] = [
      {
        chunkId: 'c1',
        content: 'hit',
        fileName: 'a.ts',
        filePath: '/a.ts',
        fileRecordId: 'f1',
        nodeId: 'chunk-c1',
        similarity: 0.9,
      },
    ];

    // First: no grouping with semantic results
    const { result, rerender } = renderHook(
      (props: { groupBy: GroupByKey }) =>
        useCollectionTree({
          data,
          expandedIds: new Set<string>(['file-f1']),
          filters: makeFilters(),
          filterToSemanticResults: true,
          groupBy: props.groupBy,
          semanticResults,
        }),
      { initialProps: { groupBy: 'none' as GroupByKey } }
    );

    // Without grouping — only f1 and c1 visible
    expect(result.current.nodes.map((n) => n.id)).toEqual(['file-f1', 'chunk-c1']);

    // Switch to groupBy type — group header appears but children are collapsed
    rerender({ groupBy: 'type' });

    const visibleIds = result.current.nodes.map((n) => n.id);
    // Group header for .ts should be present
    expect(visibleIds.some((id) => id.startsWith('group-'))).toBe(true);
    // file-f1 is a child of the group; since the group is NOT in expandedIds,
    // only the group header is visible at root level. This is correct:
    // semantic filter marks the group visible, but expansion is separate.
  });

  it('toggle groupBy with group expanded reveals semantic matches', () => {
    const data: CollectionTreeInput = {
      chunks: [
        { chunkIndex: 0, content: 'hit', fileRecordId: 'f1', id: 'c1', tokenCount: 10 },
        { chunkIndex: 0, content: 'miss', fileRecordId: 'f2', id: 'c2', tokenCount: 10 },
      ],
      files: [
        { id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 },
        { id: 'f2', name: 'b.tsx', path: '/b.tsx', size: 200 },
      ],
    };

    const semanticResults: SemanticSearchResult[] = [
      {
        chunkId: 'c1',
        content: 'hit',
        fileName: 'a.ts',
        filePath: '/a.ts',
        fileRecordId: 'f1',
        nodeId: 'chunk-c1',
        similarity: 0.9,
      },
    ];

    const groupId = 'group-type-.ts';

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>([groupId, 'file-f1']),
        filters: makeFilters(),
        filterToSemanticResults: true,
        groupBy: 'type',
        semanticResults,
      })
    );

    const ids = result.current.nodes.map((n) => n.id);
    expect(ids).toContain(groupId);
    expect(ids).toContain('file-f1');
    expect(ids).toContain('chunk-c1');
    // b.tsx group and file-f2 should NOT be visible (no semantic match)
    expect(ids).not.toContain('file-f2');
  });

  it('change sort while filter is applied', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [
        { id: 'f1', name: 'alpha.ts', path: '/alpha.ts', size: 300 },
        { id: 'f2', name: 'bravo.ts', path: '/bravo.ts', size: 100 },
        { id: 'f3', name: 'charlie.ts', path: '/charlie.ts', size: 200 },
      ],
    };

    const { result, rerender } = renderHook(
      (props: { sortState?: CollectionSortState }) =>
        useCollectionTree({
          data,
          expandedIds: new Set<string>(),
          filters: makeFilters({ searchQuery: '' }),
          ...(props.sortState ? { sortState: props.sortState } : {}),
        }),
      { initialProps: { sortState: { direction: 'asc', key: 'name' } as CollectionSortState } }
    );

    let names = result.current.nodes.map((n) => (n.data as FileData).name);
    expect(names).toEqual(['alpha.ts', 'bravo.ts', 'charlie.ts']);

    // Switch to sort by size desc
    rerender({ sortState: { direction: 'desc', key: 'size' } });
    names = result.current.nodes.map((n) => (n.data as FileData).name);
    expect(names).toEqual(['alpha.ts', 'charlie.ts', 'bravo.ts']);
  });

  it('expandedIds update correctly when grouping creates new parent IDs', () => {
    const data: CollectionTreeInput = {
      chunks: [{ chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 }],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    // Expand the group header for .ts
    const groupId = 'group-type-.ts';
    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>([groupId, 'file-f1']),
        filters: makeFilters(),
        groupBy: 'type',
      })
    );

    // group + file + chunk all visible
    const ids = result.current.nodes.map((n) => n.id);
    expect(ids).toContain(groupId);
    expect(ids).toContain('file-f1');
    expect(ids).toContain('chunk-c1');
  });
});

// ---------------------------------------------------------------------------
// Embedding status / progress computation
// ---------------------------------------------------------------------------

describe('useCollectionTree — embedding status', () => {
  it('computes "none" for file with no chunks', () => {
    const data: CollectionTreeInput = {
      chunks: [],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    const fileData = result.current.nodes[0]!.data as FileData;
    expect(fileData.embeddingStatus).toBe('none');
    expect(fileData.embeddingProgress).toBe(0);
  });

  it('computes "complete" when all chunks have embeddings', () => {
    const data: CollectionTreeInput = {
      chunks: [
        {
          chunkIndex: 0,
          content: 'x',
          embedding: [0.1],
          fileRecordId: 'f1',
          id: 'c1',
          tokenCount: 10,
        },
        {
          chunkIndex: 1,
          content: 'y',
          embedding: [0.2],
          fileRecordId: 'f1',
          id: 'c2',
          tokenCount: 10,
        },
      ],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    const fileData = result.current.nodes[0]!.data as FileData;
    expect(fileData.embeddingStatus).toBe('complete');
    expect(fileData.embeddingProgress).toBe(100);
  });

  it('computes "pending" when some chunks have embeddings but none are processing', () => {
    const data: CollectionTreeInput = {
      chunks: [
        {
          chunkIndex: 0,
          content: 'x',
          embedding: [0.1],
          fileRecordId: 'f1',
          id: 'c1',
          tokenCount: 10,
        },
        { chunkIndex: 1, content: 'y', fileRecordId: 'f1', id: 'c2', tokenCount: 10 },
      ],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    const fileData = result.current.nodes[0]!.data as FileData;
    expect(fileData.embeddingStatus).toBe('pending');
    expect(fileData.embeddingProgress).toBe(50);
  });

  it('computes "processing" when pendingChunkIds includes a chunk', () => {
    const data: CollectionTreeInput = {
      chunks: [{ chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 }],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
      pendingChunkIds: new Set(['c1']),
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
      })
    );

    const fileData = result.current.nodes[0]!.data as FileData;
    expect(fileData.embeddingStatus).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('useCollectionTree — search', () => {
  it('text search matches file names and chunk content', () => {
    const data: CollectionTreeInput = {
      chunks: [
        { chunkIndex: 0, content: 'hello world', fileRecordId: 'f1', id: 'c1', tokenCount: 10 },
        {
          chunkIndex: 0,
          content: 'searchable content',
          fileRecordId: 'f2',
          id: 'c2',
          tokenCount: 10,
        },
      ],
      files: [
        { id: 'f1', name: 'searchable.ts', path: '/searchable.ts', size: 100 },
        { id: 'f2', name: 'other.ts', path: '/other.ts', size: 50 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters({ searchQuery: 'searchable' }),
      })
    );

    // Both files should match: f1 by name, f2.c2 by content
    expect(result.current.searchMatchIds.has('file-f1')).toBe(true);
    expect(result.current.searchMatchIds.has('chunk-c2')).toBe(true);
  });

  it('empty search returns all nodes', () => {
    const data = generateTestData(5, 2);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters({ searchQuery: '' }),
      })
    );

    expect(result.current.searchMatchIds.size).toBe(0);
    expect(result.current.nodes).toHaveLength(5);
  });

  it('semantic search with empty results array shows empty state', () => {
    const data = generateTestData(3, 1);

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters(),
        filterToSemanticResults: true,
        semanticResults: [],
      })
    );

    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.filteredCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('useCollectionTree — filtering', () => {
  it('filters by embedding status', () => {
    const data: CollectionTreeInput = {
      chunks: [
        {
          chunkIndex: 0,
          content: 'x',
          embedding: [0.1],
          fileRecordId: 'f1',
          id: 'c1',
          tokenCount: 10,
        },
        { chunkIndex: 0, content: 'y', fileRecordId: 'f2', id: 'c2', tokenCount: 10 },
      ],
      files: [
        { id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 },
        { id: 'f2', name: 'b.ts', path: '/b.ts', size: 100 },
      ],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(),
        filters: makeFilters({ embeddingStatus: 'complete' }),
      })
    );

    // Only f1 has complete status
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]!.id).toBe('file-f1');
  });

  it('filters by node type', () => {
    const data: CollectionTreeInput = {
      chunks: [{ chunkIndex: 0, content: 'x', fileRecordId: 'f1', id: 'c1', tokenCount: 10 }],
      files: [{ id: 'f1', name: 'a.ts', path: '/a.ts', size: 100 }],
    };

    const { result } = renderHook(() =>
      useCollectionTree({
        data,
        expandedIds: new Set<string>(['file-f1']),
        filters: makeFilters({ nodeTypes: new Set(['file']) }),
      })
    );

    // File is included, but chunk is excluded by type filter
    // However, file itself is of type 'file' which is in nodeTypes
    expect(result.current.nodes.map((n) => n.type)).toContain('file');
  });
});
