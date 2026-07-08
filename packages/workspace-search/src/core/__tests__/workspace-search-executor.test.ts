import type {
  FileChunk,
  GrepMatch,
  GrepSearchResult,
  HybridSearchResponse,
  HybridSearchResult,
} from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedFileInfo } from '../workspace-search-executor';
import {
  buildGrepPattern,
  escapeRegExpLiteral,
  type SemanticSearchRequest,
  type TextSearchRequest,
  WorkspaceSearchExecutor,
  type WorkspaceSearchExecutorDeps,
} from '../workspace-search-executor';

const grepMatch: GrepMatch = {
  after: [],
  before: ['ctx'],
  chunkEndLine: 14,
  chunkId: 'c1',
  chunkStartLine: 10,
  line: 12,
  lineText: 'const needle = 1;',
  path: 'src/a.ts',
  rootId: 'r1',
  rootName: 'Alpha',
};

const emptyGrepResult: GrepSearchResult = {
  candidatesTruncated: false,
  matches: [],
  scanLimited: false,
  skippedMissingLineMetadata: 0,
  totalMatches: 0,
  truncated: false,
};

const baseReq: TextSearchRequest = {
  caseSensitive: false,
  embeddingSetId: 'set-1',
  isRegex: false,
  query: 'needle',
  rootIds: ['r1'],
  wholeWord: false,
};

const stubRest: Omit<WorkspaceSearchExecutorDeps, 'grepService'> = {
  embedQuery: vi.fn(),
  hybridService: { search: vi.fn() },
  resolveFiles: vi.fn(),
};

describe('WorkspaceSearchExecutor.searchText', () => {
  it('groups matches by (rootId, path) preserving service order', async () => {
    const grepService = {
      search: vi.fn().mockResolvedValue({
        candidatesTruncated: false,
        matches: [
          grepMatch,
          { ...grepMatch, line: 13 },
          { ...grepMatch, chunkId: 'c2', path: 'src/b.ts' },
        ],
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        totalMatches: 3,
        truncated: false,
      }),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const results = await executor.searchText(baseReq);
    expect(results?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(results?.files[0]?.children).toHaveLength(2);
    expect(results?.files[0]?.children[0]).toMatchObject({
      chunkId: 'c1',
      kind: 'match',
      line: 12,
    });
  });

  it('calls grepService.search with the derived pattern and default options', async () => {
    const grepService = { search: vi.fn().mockResolvedValue(emptyGrepResult) };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    await executor.searchText(baseReq);
    expect(grepService.search).toHaveBeenCalledWith({
      caseSensitive: false,
      contextLines: 1,
      embeddingSetId: 'set-1',
      isRegex: false,
      maxResults: 200,
      pattern: 'needle',
      rootIds: ['r1'],
    });
  });

  it('respects an explicit maxResults', async () => {
    const grepService = { search: vi.fn().mockResolvedValue(emptyGrepResult) };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    await executor.searchText({ ...baseReq, maxResults: 25 });
    expect(grepService.search).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 25 }));
  });

  it('escapeRegExpLiteral escapes regex metacharacters', () => {
    expect(escapeRegExpLiteral('a.b*c')).toBe('a\\.b\\*c');
  });

  it('wholeWord wraps a literal in \\b after escaping', () => {
    expect(buildGrepPattern({ isRegex: false, query: 'a.b', wholeWord: true })).toEqual({
      isRegex: true,
      pattern: '\\ba\\.b\\b',
    });
  });

  it('wholeWord wraps a regex without escaping', () => {
    expect(buildGrepPattern({ isRegex: true, query: 'foo|bar', wholeWord: true })).toEqual({
      isRegex: true,
      pattern: '\\b(?:foo|bar)\\b',
    });
  });

  it('passes a plain literal through unchanged', () => {
    expect(buildGrepPattern({ isRegex: false, query: 'a.b', wholeWord: false })).toEqual({
      isRegex: false,
      pattern: 'a.b',
    });
  });

  it('passes a plain regex through unchanged', () => {
    expect(buildGrepPattern({ isRegex: true, query: 'foo|bar', wholeWord: false })).toEqual({
      isRegex: true,
      pattern: 'foo|bar',
    });
  });

  it('a superseded request resolves null and its results are discarded', async () => {
    let resolveFirst!: (v: GrepSearchResult) => void;
    const grepService = {
      search: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<GrepSearchResult>((res) => {
              resolveFirst = res;
            })
        )
        .mockResolvedValueOnce(emptyGrepResult),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const first = executor.searchText(baseReq);
    const second = executor.searchText({ ...baseReq, query: 'newer' });
    resolveFirst({ ...emptyGrepResult, matches: [grepMatch], totalMatches: 1 });
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatchObject({ totalMatches: 0 });
  });

  it('propagates notices (scanLimited/truncated) verbatim', async () => {
    const grepService = {
      search: vi.fn().mockResolvedValue({
        candidatesTruncated: true,
        matches: [],
        scanLimited: true,
        skippedMissingLineMetadata: 5,
        totalMatches: 0,
        truncated: true,
      }),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const results = await executor.searchText(baseReq);
    expect(results?.notices).toEqual({
      candidatesTruncated: true,
      scanLimited: true,
      skippedMissingLineMetadata: 5,
      truncated: true,
    });
  });

  it('matches with no chunk metadata are dropped and counted', async () => {
    const incompleteMatch: GrepMatch = {
      after: [],
      before: [],
      line: 20,
      lineText: 'missing chunk fields',
      path: 'src/c.ts',
      rootId: 'r1',
      rootName: 'Alpha',
      // chunkId, chunkStartLine, chunkEndLine intentionally absent
    };
    const grepService = {
      search: vi.fn().mockResolvedValue({
        candidatesTruncated: false,
        matches: [incompleteMatch],
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        totalMatches: 1,
        truncated: false,
      }),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const results = await executor.searchText(baseReq);
    expect(results?.files).toHaveLength(0);
    expect(results?.notices.skippedMissingLineMetadata).toBe(1);
  });

  it('a null-rootId match is dropped and counted, producing no file group', async () => {
    const nullRootMatch: GrepMatch = { ...grepMatch, rootId: null };
    const grepService = {
      search: vi.fn().mockResolvedValue({
        candidatesTruncated: false,
        matches: [nullRootMatch],
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        totalMatches: 1,
        truncated: false,
      }),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const results = await executor.searchText(baseReq);
    expect(results?.files).toHaveLength(0);
    expect(results?.notices.skippedMissingLineMetadata).toBe(1);
  });

  it('every match child carries provenance: index', async () => {
    const grepService = {
      search: vi
        .fn()
        .mockResolvedValue({ ...emptyGrepResult, matches: [grepMatch], totalMatches: 1 }),
    };
    const executor = new WorkspaceSearchExecutor({ grepService, ...stubRest });
    const results = await executor.searchText(baseReq);
    expect(results?.files[0]?.children[0]).toMatchObject({ provenance: 'index' });
  });
});

function makeChunk(
  overrides: Partial<FileChunk> & Pick<FileChunk, 'fileRecordId' | 'id'>
): FileChunk {
  return {
    chunkIndex: 0,
    chunkSize: 100,
    chunkType: 'text',
    content: 'const needle = 1;',
    contentHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    endLine: 14,
    startLine: 10,
    tokenCount: 10,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A chunk lacking `startLine` (omitted, not `undefined` — exactOptionalPropertyTypes). */
function makeChunkMissingStartLine(fileRecordId: string, id: string): FileChunk {
  const { startLine: _startLine, ...rest } = makeChunk({ fileRecordId, id });
  return rest;
}

function makeHybridResult(
  chunk: FileChunk,
  overrides: Partial<HybridSearchResult> = {}
): HybridSearchResult {
  return {
    chunk,
    position: 1,
    rrfScore: 1,
    sourceCount: 1,
    ...overrides,
  };
}

function makeHybridResponse(results: HybridSearchResult[]): HybridSearchResponse {
  return {
    metadata: {
      ftsResultCount: 0,
      ftsSearchMs: 0,
      fusedResultCount: results.length,
      fusionMs: 0,
      totalMs: 0,
      vectorResultCount: 0,
      vectorSearchMs: 0,
    },
    results,
  };
}

const baseSemanticReq: SemanticSearchRequest = {
  embeddingSetId: 'set-1',
  query: 'needle',
  rootIds: ['r1'],
};

const semanticStubRest: Pick<WorkspaceSearchExecutorDeps, 'grepService'> = {
  grepService: { search: vi.fn() },
};

describe('WorkspaceSearchExecutor.searchSemantic', () => {
  it('calls embedQuery then hybridService.search with the derived options', async () => {
    const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2]);
    const hybridSearch = vi.fn().mockResolvedValue(makeHybridResponse([]));
    const resolveFiles = vi.fn().mockResolvedValue(new Map<string, ResolvedFileInfo>());
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    await executor.searchSemantic(baseSemanticReq);

    expect(embedQuery).toHaveBeenCalledWith('set-1', 'needle');
    expect(hybridSearch).toHaveBeenCalledWith('needle', [0.1, 0.2], {
      embeddingSetId: 'set-1',
      ftsLimit: 50,
      includeHeadline: true,
      limit: 50,
      rootIds: ['r1'],
      vectorLimit: 50,
    });
  });

  it('grows vectorLimit/ftsLimit with an explicit larger limit, but never shrinks below 50', async () => {
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi.fn().mockResolvedValue(makeHybridResponse([]));
    const resolveFiles = vi.fn().mockResolvedValue(new Map<string, ResolvedFileInfo>());
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    await executor.searchSemantic({ ...baseSemanticReq, limit: 120 });
    expect(hybridSearch).toHaveBeenCalledWith(
      'needle',
      [0.1],
      expect.objectContaining({ ftsLimit: 120, limit: 120, vectorLimit: 120 })
    );

    await executor.searchSemantic({ ...baseSemanticReq, limit: 5 });
    expect(hybridSearch).toHaveBeenLastCalledWith(
      'needle',
      [0.1],
      expect.objectContaining({ ftsLimit: 50, limit: 5, vectorLimit: 50 })
    );
  });

  it('groups chunks by fileRecordId, orders files by best score desc and children by score desc; drops chunks missing line metadata', async () => {
    const chunkA1 = makeChunk({ endLine: 5, fileRecordId: 'fileA', id: 'a1', startLine: 1 });
    const chunkA2 = makeChunk({ endLine: 10, fileRecordId: 'fileA', id: 'a2', startLine: 6 });
    const chunkB1 = makeChunk({ endLine: 3, fileRecordId: 'fileB', id: 'b1', startLine: 1 });
    const chunkMissing = makeChunkMissingStartLine('fileA', 'm1');

    // Service returns results already ranked (rrfScore descending).
    const results = [
      makeHybridResult(chunkB1, { rrfScore: 0.9 }),
      makeHybridResult(chunkA1, { rrfScore: 0.6 }),
      makeHybridResult(chunkA2, { rrfScore: 0.3 }),
      makeHybridResult(chunkMissing, { rrfScore: 0.2 }),
    ];

    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi.fn().mockResolvedValue(makeHybridResponse(results));
    const resolveFiles = vi.fn().mockResolvedValue(
      new Map<string, ResolvedFileInfo>([
        ['fileA', { dbRootId: 'r1', path: 'src/a.ts', rootDisplayName: 'Alpha' }],
        ['fileB', { dbRootId: 'r1', path: 'src/b.ts', rootDisplayName: 'Alpha' }],
      ])
    );
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const result = await executor.searchSemantic(baseSemanticReq);

    expect(resolveFiles).toHaveBeenCalledTimes(1);
    const calledIds = resolveFiles.mock.calls[0]?.[0] as string[];
    expect(calledIds).toHaveLength(2);
    expect(calledIds).toEqual(expect.arrayContaining(['fileA', 'fileB']));

    expect(result?.mode).toBe('semantic');
    // fileB has the single highest score (normalizes to 1); fileA's best (0.6) < fileB's.
    expect(result?.files.map((f) => f.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(result?.files[1]?.children.map((c) => (c.kind === 'chunk' ? c.chunkId : null))).toEqual([
      'a1',
      'a2',
    ]);
    expect(result?.notices.skippedMissingLineMetadata).toBe(1);
    expect(result?.totalMatches).toBe(3);
  });

  it('excludes a file whose resolveFiles entry has dbRootId: null (legacy NULL-root)', async () => {
    const chunk = makeChunk({ endLine: 2, fileRecordId: 'fileLegacy', id: 'c1', startLine: 1 });
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi
      .fn()
      .mockResolvedValue(makeHybridResponse([makeHybridResult(chunk, { rrfScore: 0.5 })]));
    const resolveFiles = vi
      .fn()
      .mockResolvedValue(
        new Map<string, ResolvedFileInfo>([
          ['fileLegacy', { dbRootId: null, path: 'legacy.ts', rootDisplayName: null }],
        ])
      );
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const result = await executor.searchSemantic(baseSemanticReq);
    expect(result?.files).toHaveLength(0);
    expect(result?.totalMatches).toBe(0);
    expect(result?.notices.skippedMissingLineMetadata).toBe(0);
  });

  it('excludes a file with no entry at all in the resolved map', async () => {
    const chunk = makeChunk({ endLine: 2, fileRecordId: 'fileUnknown', id: 'c1', startLine: 1 });
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi
      .fn()
      .mockResolvedValue(makeHybridResponse([makeHybridResult(chunk, { rrfScore: 0.5 })]));
    const resolveFiles = vi.fn().mockResolvedValue(new Map<string, ResolvedFileInfo>());
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const result = await executor.searchSemantic(baseSemanticReq);
    expect(result?.files).toHaveLength(0);
  });

  it('builds a chunk child with headline, normalized score, provenance and mode', async () => {
    const chunk = makeChunk({
      content: 'hi',
      endLine: 2,
      fileRecordId: 'fileA',
      id: 'c1',
      startLine: 1,
      tokenCount: 3,
    });
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi
      .fn()
      .mockResolvedValue(
        makeHybridResponse([makeHybridResult(chunk, { headline: '<b>hi</b>', rrfScore: 0.5 })])
      );
    const resolveFiles = vi
      .fn()
      .mockResolvedValue(
        new Map<string, ResolvedFileInfo>([
          ['fileA', { dbRootId: 'r1', path: 'src/a.ts', rootDisplayName: 'Alpha' }],
        ])
      );
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const result = await executor.searchSemantic(baseSemanticReq);
    expect(result?.files[0]).toMatchObject({
      dbRootId: 'r1',
      fileRecordId: 'fileA',
      path: 'src/a.ts',
      rootDisplayName: 'Alpha',
    });
    expect(result?.files[0]?.children[0]).toEqual({
      chunkId: 'c1',
      content: 'hi',
      endLine: 2,
      headline: '<b>hi</b>',
      kind: 'chunk',
      provenance: 'index',
      score: 1,
      startLine: 1,
      tokenCount: 3,
    });
    expect(result?.notices).toEqual({
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    });
  });

  it('headline defaults to null when the hybrid result omits it', async () => {
    const chunk = makeChunk({ endLine: 2, fileRecordId: 'fileA', id: 'c1', startLine: 1 });
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi
      .fn()
      .mockResolvedValue(makeHybridResponse([makeHybridResult(chunk, { rrfScore: 0.5 })]));
    const resolveFiles = vi
      .fn()
      .mockResolvedValue(
        new Map<string, ResolvedFileInfo>([
          ['fileA', { dbRootId: 'r1', path: 'src/a.ts', rootDisplayName: 'Alpha' }],
        ])
      );
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const result = await executor.searchSemantic(baseSemanticReq);
    expect(result?.files[0]?.children[0]).toMatchObject({ headline: null });
  });

  it('a semantic search superseded by a later text search resolves null (shared seq)', async () => {
    let resolveHybrid!: (v: HybridSearchResponse) => void;
    const chunk = makeChunk({ endLine: 2, fileRecordId: 'fileA', id: 'c1', startLine: 1 });
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi.fn().mockImplementationOnce(
      () =>
        new Promise<HybridSearchResponse>((res) => {
          resolveHybrid = res;
        })
    );
    const resolveFiles = vi.fn().mockResolvedValue(new Map<string, ResolvedFileInfo>());
    const grepService = { search: vi.fn().mockResolvedValue(emptyGrepResult) };
    const executor = new WorkspaceSearchExecutor({
      embedQuery,
      grepService,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const semanticPromise = executor.searchSemantic(baseSemanticReq);
    // Let embedQuery resolve so searchSemantic actually reaches (and is
    // in-flight inside) hybridService.search before a newer text search
    // supersedes it — mirrors the text-mode in-flight-superseded test.
    await new Promise((r) => setTimeout(r, 0));
    expect(hybridSearch).toHaveBeenCalledTimes(1);

    const textPromise = executor.searchText(baseReq);
    resolveHybrid(makeHybridResponse([makeHybridResult(chunk, { rrfScore: 0.5 })]));

    await expect(semanticPromise).resolves.toBeNull();
    await expect(textPromise).resolves.toMatchObject({ totalMatches: 0 });
  });

  it('a text search superseded by a later semantic search resolves null (shared seq)', async () => {
    let resolveGrep!: (v: GrepSearchResult) => void;
    const grepService = {
      search: vi.fn().mockImplementationOnce(
        () =>
          new Promise<GrepSearchResult>((res) => {
            resolveGrep = res;
          })
      ),
    };
    const embedQuery = vi.fn().mockResolvedValue([0.1]);
    const hybridSearch = vi.fn().mockResolvedValue(makeHybridResponse([]));
    const resolveFiles = vi.fn().mockResolvedValue(new Map<string, ResolvedFileInfo>());
    const executor = new WorkspaceSearchExecutor({
      embedQuery,
      grepService,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    const textPromise = executor.searchText(baseReq);
    const semanticPromise = executor.searchSemantic(baseSemanticReq);
    resolveGrep({ ...emptyGrepResult, matches: [grepMatch], totalMatches: 1 });

    await expect(textPromise).resolves.toBeNull();
    await expect(semanticPromise).resolves.toMatchObject({ totalMatches: 0 });
  });

  it('embedQuery rejection propagates untouched (no catch/swallow)', async () => {
    const boom = new Error('embed failed');
    const embedQuery = vi.fn().mockRejectedValue(boom);
    const hybridSearch = vi.fn();
    const resolveFiles = vi.fn();
    const executor = new WorkspaceSearchExecutor({
      ...semanticStubRest,
      embedQuery,
      hybridService: { search: hybridSearch },
      resolveFiles,
    });

    await expect(executor.searchSemantic(baseSemanticReq)).rejects.toThrow('embed failed');
    expect(hybridSearch).not.toHaveBeenCalled();
  });
});
