import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from '../../core/search-result-model';
import { buildSearchTreeNodes, type SearchNodeData } from '../build-tree-nodes';

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

  it('emits only the file row (hasChildren + childCount) when collapsed', () => {
    const results = makeResults([
      fileResult({ children: [textMatch(), textMatch({ line: 11 })], path: 'src/a.ts' }),
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
    expect(file?.childCount).toBe(2);
  });

  it('emits file row plus depth-1 child rows when expanded', () => {
    const match = textMatch({ chunkId: 'chunk-1', line: 10 });
    const chunk = chunkHit({ chunkId: 'chunk-9' });
    const results = makeResults([fileResult({ children: [match, chunk], path: 'src/a.ts' })]);

    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts']),
      resolveAdapterRootId,
      results,
    });

    expect(nodes).toHaveLength(3);
    const [, matchRow, chunkRow] = nodes;
    expect(matchRow?.id).toBe('m:chunk-1:10');
    expect(matchRow?.parentId).toBe('f:root-mounted:src/a.ts');
    expect(matchRow?.depth).toBe(1);
    expect(matchRow?.hasChildren).toBe(false);
    expect(chunkRow?.id).toBe('m:chunk-9');
  });

  it('sets the compositeKey from the adapter root id on file and child rows', () => {
    const results = makeResults([fileResult({ children: [textMatch()], path: 'src/a.ts' })]);
    const nodes = buildSearchTreeNodes({
      expandedIds: new Set(['f:root-mounted:src/a.ts']),
      resolveAdapterRootId,
      results,
    });

    const expectedKey = encodeFileSelection('adapter-root-mounted', 'src/a.ts');
    const fileData = nodes[0]?.data as Extract<SearchNodeData, { kind: 'file' }>;
    const childData = nodes[1]?.data as Extract<SearchNodeData, { kind: 'child' }>;
    expect(fileData.compositeKey).toBe(expectedKey);
    expect(childData.compositeKey).toBe(expectedKey);
    expect(childData.filePath).toBe('src/a.ts');
  });
});
