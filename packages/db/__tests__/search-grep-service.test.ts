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
  filePath: 'src/alpha.ts',
  startLine: 10,
  content: 'const gate = createGate();\nawait gate.open();\nreturn gate;',
};

describe('GrepSearchService', () => {
  it('returns line-accurate matches with context from chunk content', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ pattern: 'gate.open', contextLines: 1 });

    expect(result.matches).toEqual([
      {
        path: 'src/alpha.ts',
        line: 11,
        lineText: 'await gate.open();',
        before: ['const gate = createGate();'],
        after: ['return gate;'],
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
    const sensitive = await service.search({ pattern: 'CREATEGATE', caseSensitive: true });
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
    await service.search({ pattern: 'embedding\\s+gate', isRegex: true });
    expect(calls[0]?.likePattern).toBe('embedding');
  });

  it('matches with real JS regex semantics', async () => {
    const repo = stubRepository([CHUNK_A]);
    const service = new GrepSearchService(repo);
    const result = await service.search({ pattern: 'gate\\.\\w+\\(\\)', isRegex: true });
    expect(result.matches.map((m) => m.line)).toEqual([11]);
  });

  it('flags scanLimited when a regex has no extractable literal', async () => {
    const calls: GrepCandidateOptions[] = [];
    const service = new GrepSearchService(stubRepository([CHUNK_A], calls));
    const result = await service.search({ pattern: '\\d+\\.\\d+', isRegex: true });
    expect(calls[0]?.likePattern).toBeNull();
    expect(result.scanLimited).toBe(true);
  });

  it('throws a structured error for an invalid regex (no literal fallback)', async () => {
    const service = new GrepSearchService(stubRepository([]));
    await expect(service.search({ pattern: '([unclosed', isRegex: true })).rejects.toThrow(
      /Invalid regular expression pattern/
    );
  });

  it('dedupes overlapping chunks on (path, line) and sorts by path then line', async () => {
    const overlapping: GrepCandidate[] = [
      { filePath: 'src/b.ts', startLine: 5, content: 'needle here\nfiller' },
      { filePath: 'src/b.ts', startLine: 4, content: 'previous\nneedle here' },
      { filePath: 'src/a.ts', startLine: 1, content: 'needle first' },
    ];
    const service = new GrepSearchService(stubRepository(overlapping));
    const result = await service.search({ pattern: 'needle' });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/a.ts:1', 'src/b.ts:5']);
    expect(result.totalMatches).toBe(2); // 3 raw hits, deduped to 2 unique (path, line) pairs
  });

  it('caps results at maxResults and reports truncation + totalMatches', async () => {
    const many: GrepCandidate[] = [
      { filePath: 'src/c.ts', startLine: 1, content: 'hit\nhit\nhit\nhit' },
    ];
    const service = new GrepSearchService(stubRepository(many));
    const result = await service.search({ pattern: 'hit', maxResults: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('skips chunks without startLine and counts them', async () => {
    const noLines: GrepCandidate[] = [
      { filePath: 'src/d.ts', startLine: null, content: 'needle but no line metadata' },
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
});
