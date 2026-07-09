import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from '../../core/search-result-model';
import { buildSearchTreeNodes, fileResultChunks, type SearchNodeData } from '../build-tree-nodes';

function textMatch(overrides: Partial<WorkspaceSearchTextMatch> = {}): WorkspaceSearchTextMatch {
  return {
    after: [],
    before: [],
    chunkEndLine: 12,
    chunkId: 'chunk-1',
    chunkStartLine: 8,
    kind: 'match',
    line: 10,
    lineText: 'const foo = 1;',
    provenance: 'index',
    ...overrides,
  };
}

function chunkHit(overrides: Partial<WorkspaceSearchChunkHit> = {}): WorkspaceSearchChunkHit {
  return {
    chunkId: 'chunk-9',
    content: 'chunk content',
    endLine: 20,
    headline: 'headline <mark>hit</mark>',
    kind: 'chunk',
    provenance: 'index',
    score: 0.5,
    startLine: 14,
    tokenCount: 42,
    ...overrides,
  };
}

function fileResult(overrides: Partial<WorkspaceSearchFileResult> = {}): WorkspaceSearchFileResult {
  return {
    children: [textMatch()],
    dbRootId: 'root-mounted',
    path: 'src/a.ts',
    rootDisplayName: 'Mounted',
    ...overrides,
  };
}

function makeResults(files: WorkspaceSearchFileResult[]): WorkspaceSearchResults {
  return {
    files,
    mode: 'text',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    },
    totalMatches: files.reduce((n, f) => n + f.children.length, 0),
  };
}

const resolveAdapterRootId = (dbRootId: string): string | null =>
  dbRootId === 'root-unmounted' ? null : `adapter-${dbRootId}`;

describe('buildSearchTreeNodes', () => {
  it('omits files whose root resolves to null, along with their children', () => {
    const results = makeResults([
      fileResult({ dbRootId: 'root-mounted', path: 'src/a.ts' }),
      fileResult({ children: [textMatch()], dbRootId: 'root-unmounted', path: 'src/b.ts' }),
    ]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts', 'f:root-unmounted:src/b.ts']),
      resolveAdapterRootId,
      results,
    });

    const ids = nodes.map((n) => n.id);
    expect(ids).not.toContain('f:root-unmounted:src/b.ts');
    expect(nodes.every((n) => !n.id.includes('root-unmounted'))).toBe(true);
  });

  it('emits only the file row (hasChildren + chunk-group childCount) when collapsed', () => {
    // Two matches sharing chunk-1 collapse to a single chunk group.
    const results = makeResults([
      fileResult({
        children: [
          textMatch({ chunkId: 'chunk-1', line: 10 }),
          textMatch({ chunkId: 'chunk-1', line: 11 }),
        ],
        path: 'src/a.ts',
      }),
    ]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(),
      resolveAdapterRootId,
      results,
    });

    expect(nodes).toHaveLength(1);
    const [file] = nodes;
    expect(file?.id).toBe('f:root-mounted:src/a.ts');
    expect(file?.type).toBe('file');
    expect(file?.parentId).toBeNull();
    expect(file?.depth).toBe(0);
    expect(file?.hasChildren).toBe(true);
    expect(file?.childCount).toBe(1);
  });

  it('groups two matches sharing a chunk into ONE chunk node with two match children', () => {
    const results = makeResults([
      fileResult({
        children: [
          textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 9 }),
          textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 11 }),
        ],
        path: 'src/a.ts',
      }),
    ]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts', 'c:chunk-1']),
      resolveAdapterRootId,
      results,
    });

    // file, chunk, match, match
    expect(nodes.map((n) => n.id)).toEqual([
      'f:root-mounted:src/a.ts',
      'c:chunk-1',
      'm:chunk-1:9',
      'm:chunk-1:11',
    ]);
    const [, chunkRow, first, second] = nodes;
    expect(chunkRow?.type).toBe('chunk');
    expect(chunkRow?.depth).toBe(1);
    expect(chunkRow?.hasChildren).toBe(true);
    expect(chunkRow?.childCount).toBe(2);
    const chunkData = chunkRow?.data as Extract<SearchNodeData, { kind: 'text-chunk' }>;
    expect(chunkData.kind).toBe('text-chunk');
    expect(chunkData.matchCount).toBe(2);
    expect(chunkData.chunkId).toBe('chunk-1');
    expect(chunkData.chunkStartLine).toBe(8);
    expect(chunkData.chunkEndLine).toBe(12);
    expect(first?.parentId).toBe('c:chunk-1');
    expect(first?.depth).toBe(2);
    expect(first?.hasChildren).toBe(false);
    expect(second?.parentId).toBe('c:chunk-1');
  });

  it('emits two chunk nodes in first-seen order for two chunks in one file', () => {
    const results = makeResults([
      fileResult({
        children: [
          textMatch({ chunkId: 'chunk-b', line: 30 }),
          textMatch({ chunkId: 'chunk-a', line: 10 }),
        ],
        path: 'src/a.ts',
      }),
    ]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts', 'c:chunk-a', 'c:chunk-b']),
      resolveAdapterRootId,
      results,
    });

    const chunkIds = nodes.filter((n) => n.depth === 1).map((n) => n.id);
    expect(chunkIds).toEqual(['c:chunk-b', 'c:chunk-a']);
  });

  it('hides match rows when their chunk is collapsed but keeps the chunk visible', () => {
    const results = makeResults([
      fileResult({
        children: [textMatch({ chunkId: 'chunk-1', line: 9 })],
        path: 'src/a.ts',
      }),
    ]);

    const nodes = buildSearchTreeNodes({
      // File expanded, chunk NOT expanded.
      expandedIds: new Set(['f:root-mounted:src/a.ts']),
      resolveAdapterRootId,
      results,
    });

    expect(nodes.map((n) => n.id)).toEqual(['f:root-mounted:src/a.ts', 'c:chunk-1']);
    expect(nodes.some((n) => n.depth === 2)).toBe(false);
    expect(nodes.find((n) => n.id === 'c:chunk-1')?.hasChildren).toBe(true);
  });

  it('leaves the semantic shape unchanged: file → chunk with a checkbox-level chunk id', () => {
    const results = makeResults([
      fileResult({ children: [chunkHit({ chunkId: 'chunk-9', startLine: 14 })], path: 'src/a.ts' }),
    ]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts']),
      resolveAdapterRootId,
      results,
    });

    expect(nodes).toHaveLength(2);
    const [, chunkRow] = nodes;
    expect(chunkRow?.id).toBe('m:chunk-9');
    expect(chunkRow?.type).toBe('chunk');
    expect(chunkRow?.depth).toBe(1);
    expect(chunkRow?.hasChildren).toBe(false);
    expect((chunkRow?.data as Extract<SearchNodeData, { kind: 'chunk' }>).kind).toBe('chunk');
  });

  it('sets the compositeKey from the adapter root id on file, chunk, and match rows', () => {
    const results = makeResults([fileResult({ children: [textMatch()], path: 'src/a.ts' })]);
    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts', 'c:chunk-1']),
      resolveAdapterRootId,
      results,
    });

    const expectedKey = encodeFileSelection('adapter-root-mounted', 'src/a.ts');
    const fileData = nodes[0]?.data as Extract<SearchNodeData, { kind: 'file' }>;
    const chunkData = nodes[1]?.data as Extract<SearchNodeData, { kind: 'text-chunk' }>;
    const matchData = nodes[2]?.data as Extract<SearchNodeData, { kind: 'match' }>;
    expect(fileData.compositeKey).toBe(expectedKey);
    expect(chunkData.compositeKey).toBe(expectedKey);
    expect(chunkData.filePath).toBe('src/a.ts');
    expect(matchData.compositeKey).toBe(expectedKey);
    expect(matchData.filePath).toBe('src/a.ts');
  });
});

describe('fileResultChunks', () => {
  it('returns grouped text chunks (deduped by chunkId, first-seen bounds)', () => {
    const file = fileResult({
      children: [
        textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 9 }),
        textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 11 }),
        textMatch({ chunkEndLine: 40, chunkId: 'chunk-2', chunkStartLine: 30, line: 31 }),
      ],
    });
    expect(fileResultChunks(file)).toEqual([
      { chunkId: 'chunk-1', endLine: 12, startLine: 8 },
      { chunkId: 'chunk-2', endLine: 40, startLine: 30 },
    ]);
  });

  it('returns semantic chunk hits 1:1', () => {
    const file = fileResult({
      children: [chunkHit({ chunkId: 'chunk-9', endLine: 20, startLine: 14 })],
    });
    expect(fileResultChunks(file)).toEqual([{ chunkId: 'chunk-9', endLine: 20, startLine: 14 }]);
  });
});
