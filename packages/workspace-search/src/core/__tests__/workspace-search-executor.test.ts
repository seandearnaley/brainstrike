import type { GrepMatch, GrepSearchResult } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  buildGrepPattern,
  escapeRegExpLiteral,
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
