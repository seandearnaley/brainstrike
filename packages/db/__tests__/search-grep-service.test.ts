import { describe, expect, it } from 'vitest';
import type { GrepCandidate, GrepCandidateOptions } from '../src/models/grep.js';
import { GrepSearchService } from '../src/search/grep-search-service.js';

function stubRepository(candidates: GrepCandidate[], calls: GrepCandidateOptions[] = []) {
  return {
    calls,
    findGrepCandidates: (options: GrepCandidateOptions): Promise<GrepCandidate[]> => {
      calls.push(options);
      return Promise.resolve(candidates);
    },
  };
}

const CHUNK_A: GrepCandidate = {
  chunkId: 'chunk-a',
  content: 'const gate = createGate();\nawait gate.open();\nreturn gate;',
  endLine: 12,
  filePath: 'src/alpha.ts',
  startLine: 10,
};

describe('GrepSearchService', () => {
  it('returns line-accurate matches with context from chunk content', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ contextLines: 1, pattern: 'gate.open' });

    expect(result.matches).toEqual([
      {
        after: ['return gate;'],
        before: ['const gate = createGate();'],
        chunkEndLine: 12,
        chunkId: 'chunk-a',
        chunkStartLine: 10,
        line: 11,
        lineText: 'await gate.open();',
        path: 'src/alpha.ts',
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.scanLimited).toBe(false);
  });

  it('is case-insensitive by default and case-sensitive on request', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const insensitive = await service.search({ pattern: 'CREATEGATE' });
    expect(insensitive.matches).toHaveLength(1);
    const sensitive = await service.search({ caseSensitive: true, pattern: 'CREATEGATE' });
    expect(sensitive.matches).toHaveLength(0);
  });

  it('passes an escaped ILIKE pattern for literal mode', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([], calls));
    await service.search({ pattern: '100%_done' });
    expect(calls[0]?.likePattern).toBe('100\\%\\_done');
    expect(calls[0]?.caseSensitive).toBe(false);
  });

  it('prefilters regex mode on the longest extracted literal', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([], calls));
    await service.search({ isRegex: true, pattern: 'embedding\\s+gate' });
    expect(calls[0]?.likePattern).toBe('embedding');
  });

  it('matches with real JS regex semantics', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ isRegex: true, pattern: 'gate\\.\\w+\\(\\)' });
    expect(result.matches.map((m) => m.line)).toEqual([11]);
  });

  it('flags scanLimited when a regex has no extractable literal', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([CHUNK_A], calls));
    const result = await service.search({ isRegex: true, pattern: '\\d+\\.\\d+' });
    expect(calls[0]?.likePattern).toBeNull();
    expect(result.scanLimited).toBe(true);
  });

  it('throws a structured error for an invalid regex (no literal fallback)', async () => {
    const service = new GrepSearchService(stubRepository([]));
    await expect(service.search({ isRegex: true, pattern: '([unclosed' })).rejects.toThrow(
      /Invalid regular expression pattern/
    );
  });

  it('dedupes overlapping chunks on (path, line) and sorts by path then line', async () => {
    const overlapping: GrepCandidate[] = [
      {
        chunkId: 'chunk-b2',
        content: 'needle here\nfiller',
        endLine: 6,
        filePath: 'src/b.ts',
        startLine: 5,
      },
      {
        chunkId: 'chunk-b1',
        content: 'previous\nneedle here',
        endLine: 5,
        filePath: 'src/b.ts',
        startLine: 4,
      },
      {
        chunkId: 'chunk-a',
        content: 'needle first',
        endLine: 1,
        filePath: 'src/a.ts',
        startLine: 1,
      },
    ];
    const service = new GrepSearchService(stubRepository(overlapping));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/a.ts:1', 'src/b.ts:5']);
    expect(result.totalMatches).toBe(2); // 3 raw hits, deduped to 2 unique (path, line) pairs
  });

  it('caps results at maxResults and reports truncation + totalMatches', async () => {
    const many: GrepCandidate[] = [
      {
        chunkId: 'chunk-c',
        content: 'hit\nhit\nhit\nhit',
        endLine: 4,
        filePath: 'src/c.ts',
        startLine: 1,
      },
    ];
    const service = new GrepSearchService(stubRepository(many));
    const result = await service.search({ maxResults: 2, pattern: 'hit' });
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('skips chunks without startLine and counts them', async () => {
    const noLines: GrepCandidate[] = [
      {
        chunkId: 'chunk-d',
        content: 'needle but no line metadata',
        endLine: null,
        filePath: 'src/d.ts',
        startLine: null,
      },
    ];
    const service = new GrepSearchService(stubRepository(noLines));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches).toHaveLength(0);
    expect(result.skippedMissingLineMetadata).toBe(1);
  });

  it('rejects patterns shorter than 2 characters', async () => {
    const service = new GrepSearchService(stubRepository([]));
    await expect(service.search({ pattern: 'x' })).rejects.toThrow(/at least 2 characters/);
  });

  it('carries rootId and rootName from the candidate onto each match', async () => {
    const rooted: GrepCandidate[] = [
      {
        chunkId: 'chunk-x',
        content: 'needle here',
        endLine: 1,
        filePath: 'src/x.ts',
        rootId: 'r1',
        rootName: 'Alpha',
        startLine: 1,
      },
    ];
    const service = new GrepSearchService(stubRepository(rooted));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches[0]?.rootId).toBe('r1');
    expect(result.matches[0]?.rootName).toBe('Alpha');
  });

  it('dedupes per (root, path, line) so same-path files in different roots both match', async () => {
    // Two roots each have README.md with an identical line — the multi-root bug
    // is that a (path, line) dedupe key collapses these into one match.
    const sameRelativePath: GrepCandidate[] = [
      {
        chunkId: 'chunk-readme-a',
        content: 'needle',
        endLine: 1,
        filePath: 'README.md',
        rootId: 'root-a',
        rootName: 'ProjectA',
        startLine: 1,
      },
      {
        chunkId: 'chunk-readme-b',
        content: 'needle',
        endLine: 1,
        filePath: 'README.md',
        rootId: 'root-b',
        rootName: 'ProjectB',
        startLine: 1,
      },
    ];
    const service = new GrepSearchService(stubRepository(sameRelativePath));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => `${m.rootName}:${m.path}:${m.line}`)).toEqual([
      'ProjectA:README.md:1',
      'ProjectB:README.md:1',
    ]);
  });

  it('forwards an optional rootId filter to the candidate query', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([], calls));
    await service.search({ pattern: 'needle', rootId: 'root-a' });
    expect(calls[0]?.rootId).toBe('root-a');
  });
});
