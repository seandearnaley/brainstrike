import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import { BoundaryFailureError, refusalError } from '@brainstrike/assistant-contract';
import { projectGrepSearchModelOutput } from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearchWith } from '../../assistant-server/grep-search-core';
import { nativeGrepFixture } from './_c1-a-helpers';

const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

// The host's grep index: Main's native index read (`desktop-read/grep-index`
// is served by `nativeGrepIndex`), authorizing every root the case opens.
let f = nativeGrepFixture();

function grepSearch(input: GrepSearchInput, runtimeData: RuntimeData | undefined) {
  return runGrepSearchWith(input, runtimeData, f.index);
}

beforeEach(() => {
  f = nativeGrepFixture();
  loggerErrorMock.mockReset();
});

describe('grep search tool', () => {
  it('defaults to files mode: aggregated per-path summaries, no line content', async () => {
    f.serve([
      { content: 'needle one\nplain\nneedle two', path: 'src/x.ts', start_line: 1 },
      { content: 'needle here', path: 'src/y.ts', start_line: 40 },
    ]);
    const result = await grepSearch({ pattern: 'needle' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([
      { firstLine: 1, matchCount: 2, path: 'src/x.ts', rootId: 'root', source: 'index' },
      { firstLine: 40, matchCount: 1, path: 'src/y.ts', rootId: 'root', source: 'index' },
    ]);
    expect(result.totalFiles).toBe(2);
    expect(result.totalMatches).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    // With no open root on disk, the live pass is skipped; results are index-only.
    expect(result.liveEngine).toBe('skipped');
  });

  it('returns bare path:line matches in content mode — context is opt-in (BST-1193)', async () => {
    f.serve([{ content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 }]);
    const result = await grepSearch({ outputMode: 'content', pattern: 'needle' }, undefined);
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    // The internal chunk-locator fields (chunkId/chunkStartLine/chunkEndLine) are
    // stripped from the model-facing output to save tokens. contextLines
    // defaults to 0: searches locate, reads understand — every studied peer
    // ships no context by default (opencode has no option; hermes defaults 0).
    expect(result.matches).toEqual([
      {
        after: [],
        before: [],
        line: 11,
        lineText: 'needle line',
        path: 'src/x.ts',
        rootId: 'root',
        source: 'index',
      },
    ]);
    const [match] = result.matches;
    expect(match).not.toHaveProperty('chunkId');
    expect(match).not.toHaveProperty('chunkStartLine');
    expect(match).not.toHaveProperty('chunkEndLine');
    expect(result.truncated).toBe(false);
  });

  it('returns surrounding context when contextLines is requested explicitly', async () => {
    f.serve([{ content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 }]);
    const result = await grepSearch(
      { contextLines: 1, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([
      {
        after: ['omega'],
        before: ['alpha'],
        line: 11,
        lineText: 'needle line',
        path: 'src/x.ts',
        rootId: 'root',
        source: 'index',
      },
    ]);
  });

  it('mentions contextLines in paging hints only when context was requested', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `needle ${i}`).join('\n');
    f.serve([{ content: lines, path: 'src/x.ts', start_line: 1 }]);

    const withContext = await grepSearch(
      { contextLines: 1, maxResults: 2, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    expect(withContext.hint).toContain('contextLines: 0');

    const defaultContext = await grepSearch(
      { maxResults: 2, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    expect(defaultContext.hint).toContain('offset: 2');
    expect(defaultContext.hint).not.toContain('contextLines');
  });

  it('pages content matches with offset and emits a continuation hint', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `needle ${i}`).join('\n');
    f.serve([{ content: lines, path: 'src/x.ts', start_line: 1 }]);
    const result = await grepSearch(
      { contextLines: 0, maxResults: 2, offset: 2, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches.map((m) => m.lineText)).toEqual(['needle 2', 'needle 3']);
    expect(result.offset).toBe(2);
    expect(result.totalMatches).toBe(6);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('offset: 4');
  });

  it('self-bounds oversized files-mode output and steers toward content mode', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      content: 'needle in a haystack of content',
      path: `packages/some-package/src/deeply/nested/dir-${i}/file-with-a-long-name-${i}.ts`,
      start_line: 1,
    }));
    f.serve(rows);
    const result = await grepSearch({ pattern: 'needle' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // The native grep protocol admits at most 200 candidate chunks per call.
    expect(result.totalFiles).toBe(200);
    expect(result.files.length).toBeLessThan(200);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('outputMode');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
  });

  it('does not advertise a non-advancing offset when candidate limits yield no matches', async () => {
    f.serve(
      Array.from({ length: 500 }, (_, i) => ({
        content: 'authoritative matcher finds no result',
        path: `src/candidate-${i}.ts`,
        start_line: 1,
      }))
    );

    const result = await grepSearch({ pattern: 'needle' }, undefined);

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.candidatesTruncated).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.hint).toMatch(/narrow|different|specific/i);
    expect(result.hint).not.toContain('Continue with offset:');
  });

  it('content mode: candidate limits with complete pagination still carry terminal guidance', async () => {
    // 500 prefilter candidates (limit hit) but the authoritative matcher keeps
    // nothing: pagination is "complete", yet matches may exist in unexamined
    // candidates. The result must carry a hint (the model projection throws on
    // flagged results without guidance) and must not advertise an offset.
    f.serve(
      Array.from({ length: 500 }, (_, i) => ({
        content: 'authoritative matcher finds no result',
        path: `src/candidate-${i}.ts`,
        start_line: 1,
      }))
    );

    const result = await grepSearch({ outputMode: 'content', pattern: 'needle' }, undefined);

    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.candidatesTruncated).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.hint).toMatch(/narrow|different|specific/i);
    expect(result.hint).not.toContain('Continue with offset:');
    expect(projectGrepSearchModelOutput(result).value).toContain('continue:');
  });

  it('advances the offset past a single match too large to fit the budget', async () => {
    // One indexed line larger than the whole output budget (e.g. minified bundle).
    f.serve([
      { content: `${'x'.repeat(15_000)} needle`, path: 'dist/bundle.min.js', start_line: 1 },
      { content: 'small needle line', path: 'src/ok.ts', start_line: 1 },
    ]);
    const result = await grepSearch(
      { contextLines: 0, maxResults: 1, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    // The hint must ADVANCE (offset: 1), never repeat the same offset.
    expect(result.hint).toContain('too large');
    expect(result.hint).toContain('offset: 1');
  });

  it('makes the pagination cap terminal instead of repeating an unreachable offset', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `needle ${i}`).join('\n');
    f.serve([{ content: lines, path: 'src/big.ts', start_line: 1 }]);
    const result = await grepSearch(
      { contextLines: 0, offset: 2000, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(2100);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('Pagination cap reached');
    expect(result.hint).not.toContain('offset: 2000');
  });

  it('projects an unprefilterable regex over a small workspace without crashing (BST-951)', async () => {
    // Debug-bundle repro (run-da4fc85a): an alternation regex has no trigram
    // literal, but the bounded scan covered the whole tiny workspace — the
    // result is exhaustive, must NOT be scan-limited, and must project cleanly
    // instead of killing the run.
    f.serve([
      { content: 'needle one\nplain', path: 'src/x.ts', start_line: 1 },
      { content: 'thread two', path: 'src/y.ts', start_line: 1 },
    ]);
    const result = await grepSearch({ isRegex: true, pattern: 'needle|thread' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.scanLimited).toBe(false);
    expect(result.candidatesTruncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    expect(() => projectGrepSearchModelOutput(result)).not.toThrow();
  });

  it('emits a refinement hint (not a dead offset) when candidate limits hide files-mode matches', async () => {
    // 500 candidates hit the pool cap; only 2 survive the authoritative
    // matcher and both are shown. Nothing more is pageable, so the hint must
    // advise refinement — a "Continue with offset: 2" of totalFiles=2 would
    // send the model to a guaranteed-empty page.
    f.serve(
      Array.from({ length: 500 }, (_, i) => ({
        content: i < 2 ? 'needle here' : 'no match in this chunk',
        path: `src/candidate-${i}.ts`,
        start_line: 1,
      }))
    );
    const result = await grepSearch({ pattern: 'needle' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.candidatesTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(2);
    expect(result.hint).toMatch(/narrow|specific|filePaths/i);
    expect(result.hint).not.toContain('Continue with offset:');
    // Files mode is a survey — the terminal hint must keep the content-mode
    // drill-down pointer so the happy path doesn't lose a round trip.
    expect(result.hint).toContain("outputMode: 'content'");
    expect(() => projectGrepSearchModelOutput(result)).not.toThrow();
  });

  it('emits a hint when candidate limits leave a fully-shown content page incomplete', async () => {
    // Same cap, content mode: truncated=false because every reachable match is
    // shown, but candidatesTruncated means the pool may have hidden more. The
    // projection contract requires guidance for ANY limited result — today this
    // shape has no hint and crashes the whole run at the projection seam.
    f.serve(
      Array.from({ length: 500 }, (_, i) => ({
        content: i < 2 ? 'needle here' : 'no match in this chunk',
        path: `src/candidate-${i}.ts`,
        start_line: 1,
      }))
    );
    const result = await grepSearch(
      { contextLines: 0, outputMode: 'content', pattern: 'needle' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.candidatesTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);
    expect(result.hint).toMatch(/narrow|specific|filePaths/i);
    expect(result.hint).not.toContain('Continue with offset:');
    expect(() => projectGrepSearchModelOutput(result)).not.toThrow();
  });

  it('steers scan-limited content results toward a prefilterable pattern', async () => {
    // Unprefilterable regex AND the bounded scan hit its cap: the scan really
    // was limited. The hint must say how to search the rest of the workspace
    // (longer literal / isRegex: false), not offer an offset that cannot help.
    f.serve(
      Array.from({ length: 500 }, (_, i) => ({
        content: i < 2 ? 'version 1.5 shipped' : 'no digits here',
        path: `src/candidate-${i}.ts`,
        start_line: 1,
      }))
    );
    const result = await grepSearch(
      { contextLines: 0, isRegex: true, outputMode: 'content', pattern: '\\d+\\.\\d+' },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.scanLimited).toBe(true);
    expect(result.candidatesTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);
    expect(result.hint).toMatch(/literal/i);
    // This branch only fires for regex patterns; advising isRegex: false would
    // turn the regex into a literal-string search for different matches.
    expect(result.hint).not.toContain('isRegex: false');
    expect(() => projectGrepSearchModelOutput(result)).not.toThrow();
  });

  it('surfaces invalid-regex errors without coercion', async () => {
    await expect(grepSearch({ isRegex: true, pattern: '([' }, undefined)).rejects.toThrow(
      /Invalid regular expression pattern/
    );
    expect(f.grep).not.toHaveBeenCalled();
  });

  it('sanitizes raw repository/db errors to a generic message', async () => {
    f.grep.mockRejectedValue(new Error('relation "file_chunks" does not exist'));
    const promise = grepSearch({ pattern: 'needle' }, undefined);
    await expect(promise).rejects.toThrow(/Unable to perform grep search/);
    await expect(promise).rejects.not.toThrow(/file_chunks/);
  });

  // Live smoke 2026-10-16 (Workspace Index: Blocked): Main refused the grep
  // with its fixed, model-readable reason ("The search index could not prepare
  // its sources."), and this catch replaced it with the generic message, which
  // the tool guard then hid as "did not complete successfully". A typed
  // refusal passes through, as the guard reads it; a fault stays hidden.
  it('passes the index’s typed refusal through, and still hides its faults', async () => {
    const refusal = refusalError(
      'availability',
      'native-index-source-failure',
      'The search index could not prepare its sources.'
    );
    const refused = runGrepSearchWith({ pattern: 'needle' }, undefined, () =>
      Promise.reject(refusal)
    );
    await expect(refused).rejects.toBe(refusal);

    const fault = new BoundaryFailureError({
      category: 'internal',
      code: 'boundary.internal',
      correlationId: 'fault-1',
      kind: 'fault',
      message: 'Something went wrong. The details were recorded in the diagnostic log.',
    });
    await expect(
      runGrepSearchWith({ pattern: 'needle' }, undefined, () => Promise.reject(fault))
    ).rejects.toThrow(/Unable to perform grep search/);
  });

  it('redacts grep patterns from failure logs', async () => {
    f.grep.mockRejectedValue(new Error('repository unavailable'));
    const pattern = 'OPENAI_API_KEY=sk-sensitive';

    await expect(grepSearch({ pattern }, undefined)).rejects.toThrow(
      /Unable to perform grep search/
    );

    expect(loggerErrorMock).toHaveBeenCalledWith('grepSearch failed', {
      error: expect.any(Error),
      pattern: { redacted: true },
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('sk-sensitive');
  });

  it('adds case-insensitive steering without leaking probe matches into the result', async () => {
    f.serveOnce([]);
    f.serveOnce([{ content: 'needle lower-case', path: 'src/case.ts', start_line: 1 }]);

    const result = await grepSearch({ caseSensitive: true, pattern: 'Needle' }, undefined);

    expect(result.totalMatches).toBe(0);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([]);
    expect(result.probeNote).toBe(
      "0 exact-case matches, but 1 case-insensitive matches — the pattern's casing may be wrong."
    );
    expect(f.grep).toHaveBeenCalledTimes(2);
  });

  it('adds literal steering for a regex zero-match', async () => {
    f.serveOnce([]);
    f.serveOnce([{ content: String.raw`token\d+`, path: 'src/literal.ts', start_line: 1 }]);

    const result = await grepSearch({ isRegex: true, pattern: String.raw`token\d+` }, undefined);

    expect(result.totalMatches).toBe(0);
    expect(result.probeNote).toBe(
      '0 regex matches, but 1 literal matches — regex metacharacters may need escaping.'
    );
    expect(f.grep).toHaveBeenCalledTimes(2);
  });

  it('omits probeNote when every eligible index probe misses', async () => {
    f.serve([]);

    const result = await grepSearch(
      { caseSensitive: true, isRegex: true, pattern: 'missing-token' },
      undefined
    );

    expect(result).not.toHaveProperty('probeNote');
    expect(f.grep).toHaveBeenCalledTimes(3);
  });

  it('does not run any probe query after the main pass finds a match', async () => {
    f.serve([{ content: 'Needle exact', path: 'src/exact.ts', start_line: 1 }]);

    const result = await grepSearch({ caseSensitive: true, pattern: 'Needle' }, undefined);

    expect(result.totalMatches).toBe(1);
    expect(result).not.toHaveProperty('probeNote');
    expect(f.grep).toHaveBeenCalledOnce();
  });

  it('round-trips a zero-match probe note through the model projection', async () => {
    f.serveOnce([]);
    f.serveOnce([{ content: 'needle lower-case', path: 'src/case.ts', start_line: 1 }]);

    const result = await grepSearch({ caseSensitive: true, pattern: 'Needle' }, undefined);
    const projection = projectGrepSearchModelOutput(result);

    expect(projection.value).toContain(
      "note: 0 exact-case matches, but 1 case-insensitive matches — the pattern's casing may be wrong."
    );
  });
});

describe('grep search tool multi-root', () => {
  const TWO_ROOTS = {
    workspaceRoots: [
      { displayName: 'ProjectA', path: '/work/ProjectA', rootId: 'db-root-a' },
      { displayName: 'ProjectB', path: '/work/ProjectB', rootId: 'db-root-b' },
    ],
  } as unknown as RuntimeData;

  beforeEach(() => {
    f = nativeGrepFixture({ authorizedRootIds: ['db-root-a', 'db-root-b'] });
  });

  it('scopes the query to the resolved root when `root` is provided', async () => {
    f.serve([]);
    await grepSearch({ pattern: 'needle', root: 'ProjectB' }, TWO_ROOTS);
    expect(f.grep).toHaveBeenCalledWith(expect.objectContaining({ rootIds: ['db-root-b'] }));
  });

  it('errors clearly (and skips the DB) when `root` names a folder that is not open', async () => {
    await expect(grepSearch({ pattern: 'needle', root: 'Nope' }, TWO_ROOTS)).rejects.toThrow(
      /no folder "Nope"/i
    );
    expect(f.grep).not.toHaveBeenCalled();
  });

  // The native index attributes each hit to a root id only; the label comes
  // from the run's own open roots.
  it('labels file summaries with their root and keeps same-path files in different roots distinct', async () => {
    f.serve([
      { content: 'needle', path: 'README.md', root_id: 'db-root-a', start_line: 1 },
      { content: 'needle', path: 'README.md', root_id: 'db-root-b', start_line: 1 },
    ]);
    const result = await grepSearch({ pattern: 'needle' }, TWO_ROOTS);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toHaveLength(2);
    expect(result.files.map((file) => `${file.rootName}/${file.path}`).sort()).toEqual([
      'ProjectA/README.md',
      'ProjectB/README.md',
    ]);
  });

  it('labels content matches with rootId and rootName', async () => {
    f.serve([{ content: 'needle line', path: 'src/x.ts', root_id: 'db-root-a', start_line: 5 }]);
    const result = await grepSearch({ outputMode: 'content', pattern: 'needle' }, TWO_ROOTS);
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches[0]?.rootName).toBe('ProjectA');
    expect(result.matches[0]?.rootId).toBe('db-root-a');
  });
});

/**
 * BST-764. `runGrepSearch` forwarded the model's raw `filePaths` to BOTH the
 * indexed and live passes, and only the live pass transformed it — with
 * `p.replace(/^\/+/, '')`, which turns an absolute path into a never-matching
 * relative one. The call succeeded with `totalMatches: 0` for a file that
 * plainly matched.
 *
 * These are the tool-level half of the contract: the resolver's own unit tests
 * prove the mapping, and these prove the tool actually USES it — for both
 * passes, from one list.
 */
describe('grep search tool filePaths scope (BST-764)', () => {
  const ONE_ROOT = {
    workspaceRoots: [{ displayName: 'site-qa', path: '/work/site-qa', rootId: 'db-root-a' }],
  } as unknown as RuntimeData;

  beforeEach(() => {
    f = nativeGrepFixture({ authorizedRootIds: ['db-root-a'] });
  });

  /**
   * Every string-array scope handed to the indexed grep request. The request
   * can carry BOTH a filePaths allowlist and a rootIds allowlist, so tests
   * assert containment rather than picking by position — an index-based helper
   * silently started reading rootIds when root pinning was added.
   */
  function indexedStringArrays(): string[][] {
    const request = f.grep.mock.calls.at(0)?.[0];
    return [request?.filePaths, request?.rootIds].flatMap((scope) => (scope ? [[...scope]] : []));
  }

  it('resolves an absolute path inside the root to the root-relative form the index stores', async () => {
    f.serve([{ content: 'needle', path: 'proof.html', root_id: 'db-root-a', start_line: 1 }]);

    const result = await grepSearch(
      { filePaths: ['/work/site-qa/proof.html'], pattern: 'needle' },
      ONE_ROOT
    );

    // The indexed pass must receive `proof.html`, NOT the absolute path and NOT
    // the old `work/site-qa/proof.html` mangling.
    expect(indexedStringArrays()).toContainEqual(['proof.html']);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // ...and the call actually finds the file, which is the whole point.
    expect(result.totalMatches).toBe(1);
  });

  it('rejects a path outside every open folder instead of returning a clean zero-match', async () => {
    await expect(
      grepSearch({ filePaths: ['/etc/passwd'], pattern: 'needle' }, ONE_ROOT)
    ).rejects.toThrow(/not inside any open folder/i);
    // Rejected before any DB work.
    expect(f.grep).not.toHaveBeenCalled();
  });

  it('surfaces the scope error to the model rather than the generic fallback', async () => {
    // `Unable to perform grep search right now` would tell the model nothing and
    // invite a retry of the same broken call.
    await expect(
      grepSearch({ filePaths: ['/etc/passwd'], pattern: 'needle' }, ONE_ROOT)
    ).rejects.toThrow(/Open folders:/);
    await expect(
      grepSearch({ filePaths: ['/etc/passwd'], pattern: 'needle' }, ONE_ROOT)
    ).rejects.not.toThrow(/Try again/);
  });

  it('leaves a relative path untouched', async () => {
    f.serve([]);
    await grepSearch({ filePaths: ['src/x.ts'], pattern: 'needle' }, ONE_ROOT);
    expect(indexedStringArrays()).toContainEqual(['src/x.ts']);
  });

  it('deduplicates an absolute and relative spelling of the same file', async () => {
    f.serve([]);
    await grepSearch(
      { filePaths: ['/work/site-qa/proof.html', 'proof.html'], pattern: 'needle' },
      ONE_ROOT
    );
    expect(indexedStringArrays()).toContainEqual(['proof.html']);
  });

  it('rejects an ambiguous path under nested roots', async () => {
    const NESTED = {
      workspaceRoots: [
        { displayName: 'outer', path: '/work/site-qa', rootId: 'db-root-a' },
        { displayName: 'inner', path: '/work/site-qa/inner', rootId: 'db-root-b' },
      ],
    } as unknown as RuntimeData;
    await expect(
      grepSearch({ filePaths: ['/work/site-qa/inner/f.ts'], pattern: 'needle' }, NESTED)
    ).rejects.toThrow(/more than one open folder/i);
  });

  it('uses an explicit root to disambiguate nested roots', async () => {
    const NESTED = {
      workspaceRoots: [
        { displayName: 'outer', path: '/work/site-qa', rootId: 'db-root-a' },
        { displayName: 'inner', path: '/work/site-qa/inner', rootId: 'db-root-b' },
      ],
    } as unknown as RuntimeData;
    f.serve([]);
    await grepSearch(
      { filePaths: ['/work/site-qa/inner/f.ts'], pattern: 'needle', root: 'inner' },
      NESTED
    );
    expect(indexedStringArrays()).toContainEqual(['f.ts']);
  });
});

/**
 * Review follow-up on #2087. Flattening `/work/A/proof.html` to `proof.html`
 * dropped the root the caller named, so with sibling roots mounted the search
 * also matched `/work/B/proof.html`. That was NEWLY reachable — before the
 * resolver, an absolute path simply matched nothing — which made it a
 * regression introduced by the fix rather than a pre-existing gap.
 */
describe('grep search tool filePaths root pinning (BST-764 review)', () => {
  const SIBLING_ROOTS = {
    workspaceRoots: [
      { displayName: 'A', path: '/work/A', rootId: 'db-root-a' },
      { displayName: 'B', path: '/work/B', rootId: 'db-root-b' },
    ],
  } as unknown as RuntimeData;

  beforeEach(() => {
    f = nativeGrepFixture({ authorizedRootIds: ['db-root-a', 'db-root-b'] });
  });

  /** Every string-array scope handed to the indexed grep request. */
  function stringArrayParams(): string[][] {
    const request = f.grep.mock.calls.at(0)?.[0];
    return [request?.filePaths, request?.rootIds].flatMap((scope) => (scope ? [[...scope]] : []));
  }

  it('pins the indexed pass to the root the absolute path named', async () => {
    f.serve([]);
    await grepSearch({ filePaths: ['/work/A/proof.html'], pattern: 'needle' }, SIBLING_ROOTS);

    const arrays = stringArrayParams();
    expect(arrays).toContainEqual(['proof.html']);
    // ...and the root allowlist, so B's identically-named file cannot match.
    expect(arrays).toContainEqual(['db-root-a']);
  });

  it('does not pin roots when the allowlist is purely relative', async () => {
    // A relative path carries no root information; narrowing it to one root
    // would be a silent scope reduction, the mirror of the widening bug.
    f.serve([]);
    await grepSearch({ filePaths: ['proof.html'], pattern: 'needle' }, SIBLING_ROOTS);

    const arrays = stringArrayParams();
    expect(arrays).toContainEqual(['proof.html']);
    expect(arrays).not.toContainEqual(['db-root-a']);
  });
});
