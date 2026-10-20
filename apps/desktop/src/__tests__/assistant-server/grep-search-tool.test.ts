import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { projectGrepSearchModelOutput } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearchWith } from '../../assistant-server/grep-search-core';
import { runLiveGrep, setMaxLiveCandidateFilesForTests } from '../../assistant-server/live-grep';

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

// The real live pass, observed: grep and each zero-match probe are one
// `runLiveGrep` call apiece (ADR 0026), so the call count proves which ran.
vi.mock('../../assistant-server/live-grep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../assistant-server/live-grep')>();
  return { ...actual, runLiveGrep: vi.fn(actual.runLiveGrep) };
});

/** One region of a file on disk: `content` starts at `start_line`. */
interface DiskGrepRow {
  readonly content: string;
  readonly path: string;
  /** The open root the file lives in; the first root when absent. */
  readonly root_id?: string;
  readonly start_line: number;
}

interface DiskRootSpec {
  readonly displayName: string;
  readonly rootId: string;
}

/** Pads a row down to its start line; no case searches for it. */
const FILLER_LINE = '-';
const SINGLE_ROOT: readonly DiskRootSpec[] = [{ displayName: 'workspace', rootId: 'root' }];
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-grep-tool-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeRow(rootPath: string, row: DiskGrepRow): Promise<void> {
  const absolutePath = path.join(rootPath, row.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const padding = Array.from({ length: row.start_line - 1 }, () => FILLER_LINE);
  await fs.writeFile(absolutePath, [...padding, row.content].join('\n'));
}

/** Writes the rows into fresh temp roots and returns the run data that opens them. */
async function diskWorkspace(
  rows: readonly DiskGrepRow[],
  specs: readonly DiskRootSpec[] = SINGLE_ROOT
): Promise<RuntimeData> {
  const workspaceRoots = await Promise.all(
    specs.map(async (spec) => ({
      displayName: spec.displayName,
      path: await makeTemporaryDirectory(),
      rootId: spec.rootId,
    }))
  );
  await Promise.all(
    rows.map((row) => {
      const rootId = row.root_id ?? specs[0]?.rootId;
      const root = workspaceRoots.find((candidate) => candidate.rootId === rootId);
      if (!root) {
        throw new Error(`No temp root for row ${row.path} (root ${rootId ?? 'none'}).`);
      }
      return writeRow(root.path, row);
    })
  );
  return { workspaceRoots };
}

function rootPathOf(runtimeData: RuntimeData, rootId: string): string {
  const root = runtimeData.workspaceRoots?.find((candidate) => candidate.rootId === rootId);
  if (!root) {
    throw new Error(`No open root ${rootId}.`);
  }
  return root.path;
}

beforeEach(() => {
  loggerErrorMock.mockReset();
  vi.mocked(runLiveGrep).mockClear();
});

afterEach(async () => {
  setMaxLiveCandidateFilesForTests();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true }))
  );
});

describe('grep search tool', () => {
  it('defaults to files mode: aggregated per-path summaries, no line content', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'needle one\nplain\nneedle two', path: 'src/x.ts', start_line: 1 },
      { content: 'needle here', path: 'src/y.ts', start_line: 40 },
    ]);
    const result = await runGrepSearchWith({ pattern: 'needle' }, runtimeData);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([
      { firstLine: 1, matchCount: 2, path: 'src/x.ts', rootId: 'root', rootName: 'workspace' },
      { firstLine: 40, matchCount: 1, path: 'src/y.ts', rootId: 'root', rootName: 'workspace' },
    ]);
    expect(result.totalFiles).toBe(2);
    expect(result.totalMatches).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it('returns bare path:line matches in content mode — context is opt-in (BST-1193)', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 },
    ]);
    const result = await runGrepSearchWith(
      { outputMode: 'content', pattern: 'needle' },
      runtimeData
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    // The internal chunk-locator fields (chunkId/chunkStartLine/chunkEndLine)
    // never reach the model-facing output. contextLines defaults to 0:
    // searches locate, reads understand — every studied peer ships no context
    // by default (opencode has no option; hermes defaults 0).
    expect(result.matches).toEqual([
      {
        after: [],
        before: [],
        line: 11,
        lineText: 'needle line',
        path: 'src/x.ts',
        rootId: 'root',
        rootName: 'workspace',
      },
    ]);
    const [match] = result.matches;
    expect(match).not.toHaveProperty('chunkId');
    expect(match).not.toHaveProperty('chunkStartLine');
    expect(match).not.toHaveProperty('chunkEndLine');
    expect(result.truncated).toBe(false);
  });

  it('returns surrounding context when contextLines is requested explicitly', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'alpha\nneedle line\nomega', path: 'src/x.ts', start_line: 10 },
    ]);
    const result = await runGrepSearchWith(
      { contextLines: 1, outputMode: 'content', pattern: 'needle' },
      runtimeData
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
        rootName: 'workspace',
      },
    ]);
  });

  it('mentions contextLines in paging hints only when context was requested', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `needle ${i}`).join('\n');
    const runtimeData = await diskWorkspace([{ content: lines, path: 'src/x.ts', start_line: 1 }]);

    const withContext = await runGrepSearchWith(
      { contextLines: 1, maxResults: 2, outputMode: 'content', pattern: 'needle' },
      runtimeData
    );
    expect(withContext.hint).toContain('contextLines: 0');

    const defaultContext = await runGrepSearchWith(
      { maxResults: 2, outputMode: 'content', pattern: 'needle' },
      runtimeData
    );
    expect(defaultContext.hint).toContain('offset: 2');
    expect(defaultContext.hint).not.toContain('contextLines');
  });

  it('pages content matches with offset and emits a continuation hint', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `needle ${i}`).join('\n');
    const runtimeData = await diskWorkspace([{ content: lines, path: 'src/x.ts', start_line: 1 }]);
    const result = await runGrepSearchWith(
      { contextLines: 0, maxResults: 2, offset: 2, outputMode: 'content', pattern: 'needle' },
      runtimeData
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
    const runtimeData = await diskWorkspace(
      Array.from({ length: 400 }, (_, i) => ({
        content: 'needle in a haystack of content',
        path: `packages/some-package/src/deeply/nested/dir-${i}/file-with-a-long-name-${i}.ts`,
        start_line: 1,
      }))
    );
    const result = await runGrepSearchWith({ pattern: 'needle' }, runtimeData);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // Every matching file is counted; only the output is bounded.
    expect(result.totalFiles).toBe(400);
    expect(result.files.length).toBeLessThan(400);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('outputMode');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
  });

  // The ripgrep prefilter admits these files on the regex's literal `needle`,
  // and the authoritative matcher then rejects every line. The JS walk admits
  // every file. Either way the candidate cap is hit before all are read.
  const PREFILTER_ONLY_ROWS: readonly DiskGrepRow[] = Array.from({ length: 4 }, (_, i) => ({
    content: 'needle without digits',
    path: `src/candidate-${i}.ts`,
    start_line: 1,
  }));

  it('does not advertise a non-advancing offset when candidate limits yield no matches', async () => {
    const runtimeData = await diskWorkspace(PREFILTER_ONLY_ROWS);
    setMaxLiveCandidateFilesForTests(2);

    const result = await runGrepSearchWith(
      { isRegex: true, pattern: String.raw`needle\d+` },
      runtimeData
    );

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.candidatesTruncated).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.hint).toMatch(/narrow|different|specific/i);
    expect(result.hint).not.toContain('Continue with offset:');
  });

  it('content mode: candidate limits with complete pagination still carry terminal guidance', async () => {
    // The candidate cap is hit but the authoritative matcher keeps nothing:
    // pagination is "complete", yet matches may exist in unread candidates.
    // The result must carry a hint (the model projection throws on flagged
    // results without guidance) and must not advertise an offset.
    const runtimeData = await diskWorkspace(PREFILTER_ONLY_ROWS);
    setMaxLiveCandidateFilesForTests(2);

    const result = await runGrepSearchWith(
      { isRegex: true, outputMode: 'content', pattern: String.raw`needle\d+` },
      runtimeData
    );

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
    // One line larger than the whole output budget (e.g. a generated file).
    const runtimeData = await diskWorkspace([
      { content: `${'x'.repeat(15_000)} needle`, path: 'src/a-long-line.ts', start_line: 1 },
      { content: 'small needle line', path: 'src/ok.ts', start_line: 1 },
    ]);
    const result = await runGrepSearchWith(
      { contextLines: 0, maxResults: 1, outputMode: 'content', pattern: 'needle' },
      runtimeData
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

  it('projects an unprefilterable regex over a small workspace without crashing (BST-951)', async () => {
    // Debug-bundle repro (run-da4fc85a): an alternation regex has no prefilter
    // literal, but the bounded walk covered the whole tiny workspace — the
    // result is exhaustive, must NOT be scan-limited, and must project cleanly
    // instead of killing the run.
    const runtimeData = await diskWorkspace([
      { content: 'needle one\nplain', path: 'src/x.ts', start_line: 1 },
      { content: 'thread two', path: 'src/y.ts', start_line: 1 },
    ]);
    const result = await runGrepSearchWith(
      { isRegex: true, pattern: 'needle|thread' },
      runtimeData
    );
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.scanLimited).toBe(false);
    expect(result.candidatesTruncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    expect(() => projectGrepSearchModelOutput(result)).not.toThrow();
  });

  // Every file matches, but the candidate cap admits only two of the four.
  const CANDIDATE_CAPPED_ROWS: readonly DiskGrepRow[] = Array.from({ length: 4 }, (_, i) => ({
    content: 'needle here',
    path: `src/candidate-${i}.ts`,
    start_line: 1,
  }));

  it('emits a refinement hint (not a dead offset) when candidate limits hide files-mode matches', async () => {
    // Both matching files the cap admitted are shown. Nothing more is
    // pageable, so the hint must advise refinement — a "Continue with offset:
    // 2" of totalFiles=2 would send the model to a guaranteed-empty page.
    const runtimeData = await diskWorkspace(CANDIDATE_CAPPED_ROWS);
    setMaxLiveCandidateFilesForTests(2);

    const result = await runGrepSearchWith({ pattern: 'needle' }, runtimeData);
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
    // shown, but candidatesTruncated means the cap may have hidden more. The
    // projection contract requires guidance for ANY limited result — a shape
    // without a hint crashes the whole run at the projection seam.
    const runtimeData = await diskWorkspace(CANDIDATE_CAPPED_ROWS);
    setMaxLiveCandidateFilesForTests(2);

    const result = await runGrepSearchWith(
      { contextLines: 0, outputMode: 'content', pattern: 'needle' },
      runtimeData
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

  it('surfaces invalid-regex errors without coercion', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'needle', path: 'src/x.ts', start_line: 1 },
    ]);
    await expect(runGrepSearchWith({ isRegex: true, pattern: '([' }, runtimeData)).rejects.toThrow(
      /Invalid regular expression pattern/
    );
    expect(runLiveGrep).not.toHaveBeenCalled();
  });

  it('redacts grep patterns from failure logs', async () => {
    // An exactly scoped file over the live pass's 2 MiB read bound fails the
    // pass deterministically (a root-wide pass would skip it instead).
    const runtimeData = await diskWorkspace([
      { content: 'x'.repeat(2 * 1024 * 1024 + 1), path: 'src/huge.ts', start_line: 1 },
    ]);
    const pattern = 'OPENAI_API_KEY=sk-sensitive';

    const promise = runGrepSearchWith({ filePaths: ['src/huge.ts'], pattern }, runtimeData);
    await expect(promise).rejects.toThrow(/Unable to perform grep search/);
    // The raw failure stays in the log, never in the model's message.
    await expect(promise).rejects.not.toThrow(/bounded read size/);

    expect(loggerErrorMock).toHaveBeenCalledWith('grepSearch failed', {
      error: expect.any(Error),
      pattern: { redacted: true },
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('sk-sensitive');
  });

  it('adds case-insensitive steering without leaking probe matches into the result', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'needle lower-case', path: 'src/case.ts', start_line: 1 },
    ]);

    const result = await runGrepSearchWith({ caseSensitive: true, pattern: 'Needle' }, runtimeData);

    expect(result.totalMatches).toBe(0);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([]);
    expect(result.probeNote).toBe(
      "0 exact-case matches, but 1 case-insensitive matches — the pattern's casing may be wrong."
    );
    expect(runLiveGrep).toHaveBeenCalledTimes(2);
  });

  it('adds literal steering for a regex zero-match', async () => {
    const runtimeData = await diskWorkspace([
      { content: String.raw`token\d+`, path: 'src/literal.ts', start_line: 1 },
    ]);

    const result = await runGrepSearchWith(
      { isRegex: true, pattern: String.raw`token\d+` },
      runtimeData
    );

    expect(result.totalMatches).toBe(0);
    expect(result.probeNote).toBe(
      '0 regex matches, but 1 literal matches — regex metacharacters may need escaping.'
    );
    expect(runLiveGrep).toHaveBeenCalledTimes(2);
  });

  it('omits probeNote when every eligible probe misses on disk', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'nothing to find here', path: 'src/x.ts', start_line: 1 },
    ]);

    const result = await runGrepSearchWith(
      { caseSensitive: true, isRegex: true, pattern: 'missing-token' },
      runtimeData
    );

    expect(result).not.toHaveProperty('probeNote');
    // The search, then the case and literal probes.
    expect(runLiveGrep).toHaveBeenCalledTimes(3);
  });

  it('does not run any probe query after the main pass finds a match', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'Needle exact', path: 'src/exact.ts', start_line: 1 },
    ]);

    const result = await runGrepSearchWith({ caseSensitive: true, pattern: 'Needle' }, runtimeData);

    expect(result.totalMatches).toBe(1);
    expect(result).not.toHaveProperty('probeNote');
    expect(runLiveGrep).toHaveBeenCalledOnce();
  });

  it('round-trips a zero-match probe note through the model projection', async () => {
    const runtimeData = await diskWorkspace([
      { content: 'needle lower-case', path: 'src/case.ts', start_line: 1 },
    ]);

    const result = await runGrepSearchWith({ caseSensitive: true, pattern: 'Needle' }, runtimeData);
    const projection = projectGrepSearchModelOutput(result);

    expect(projection.value).toContain(
      "note: 0 exact-case matches, but 1 case-insensitive matches — the pattern's casing may be wrong."
    );
  });
});

describe('grep search tool multi-root', () => {
  const TWO_ROOTS: readonly DiskRootSpec[] = [
    { displayName: 'ProjectA', rootId: 'db-root-a' },
    { displayName: 'ProjectB', rootId: 'db-root-b' },
  ];

  it('scopes the search to the resolved root when `root` is provided', async () => {
    const runtimeData = await diskWorkspace(
      [
        { content: 'needle', path: 'src/x.ts', root_id: 'db-root-a', start_line: 1 },
        { content: 'needle', path: 'src/x.ts', root_id: 'db-root-b', start_line: 1 },
      ],
      TWO_ROOTS
    );
    const result = await runGrepSearchWith({ pattern: 'needle', root: 'ProjectB' }, runtimeData);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files.map((file) => `${file.rootName}/${file.path}`)).toEqual([
      'ProjectB/src/x.ts',
    ]);
  });

  it('errors clearly (and reads no disk) when `root` names a folder that is not open', async () => {
    const runtimeData = await diskWorkspace([], TWO_ROOTS);
    await expect(
      runGrepSearchWith({ pattern: 'needle', root: 'Nope' }, runtimeData)
    ).rejects.toThrow(/no folder "Nope"/i);
    expect(runLiveGrep).not.toHaveBeenCalled();
  });

  // The live pass attributes each hit to the root it read; the label comes
  // from the run's own open roots.
  it('labels file summaries with their root and keeps same-path files in different roots distinct', async () => {
    const runtimeData = await diskWorkspace(
      [
        { content: 'needle', path: 'README.md', root_id: 'db-root-a', start_line: 1 },
        { content: 'needle', path: 'README.md', root_id: 'db-root-b', start_line: 1 },
      ],
      TWO_ROOTS
    );
    const result = await runGrepSearchWith({ pattern: 'needle' }, runtimeData);
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
    const runtimeData = await diskWorkspace(
      [{ content: 'needle line', path: 'src/x.ts', root_id: 'db-root-a', start_line: 5 }],
      TWO_ROOTS
    );
    const result = await runGrepSearchWith(
      { outputMode: 'content', pattern: 'needle' },
      runtimeData
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches[0]?.rootName).toBe('ProjectA');
    expect(result.matches[0]?.rootId).toBe('db-root-a');
    expect(result.matches[0]?.line).toBe(5);
  });
});

/**
 * BST-764. `runGrepSearch` once forwarded the model's raw `filePaths` to the
 * live pass, which transformed it with `p.replace(/^\/+/, '')` — turning an
 * absolute path into a never-matching relative one. The call succeeded with
 * `totalMatches: 0` for a file that plainly matched.
 *
 * These are the tool-level half of the contract: the resolver's own unit tests
 * prove the mapping, and these prove the tool actually USES it.
 */
describe('grep search tool filePaths scope (BST-764)', () => {
  const ONE_ROOT: readonly DiskRootSpec[] = [{ displayName: 'site-qa', rootId: 'db-root-a' }];
  const UNOPENED_ROOT: RuntimeData = {
    workspaceRoots: [{ displayName: 'site-qa', path: '/work/site-qa', rootId: 'db-root-a' }],
  };
  const NESTED_ROOTS: RuntimeData = {
    workspaceRoots: [
      { displayName: 'outer', path: '/work/site-qa', rootId: 'db-root-a' },
      { displayName: 'inner', path: '/work/site-qa/inner', rootId: 'db-root-b' },
    ],
  };

  it('resolves an absolute path inside the root to the root-relative file', async () => {
    const runtimeData = await diskWorkspace(
      [
        { content: 'needle', path: 'proof.html', start_line: 1 },
        { content: 'needle', path: 'other.html', start_line: 1 },
      ],
      ONE_ROOT
    );

    const result = await runGrepSearchWith(
      {
        filePaths: [path.join(rootPathOf(runtimeData, 'db-root-a'), 'proof.html')],
        pattern: 'needle',
      },
      runtimeData
    );

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // The call finds `proof.html`, NOT a mangled `work/site-qa/proof.html`
    // zero-match, and stays scoped to that one file.
    expect(result.files).toEqual([
      { firstLine: 1, matchCount: 1, path: 'proof.html', rootId: 'db-root-a', rootName: 'site-qa' },
    ]);
    expect(result.totalMatches).toBe(1);
  });

  it('rejects a path outside every open folder instead of returning a clean zero-match', async () => {
    await expect(
      runGrepSearchWith({ filePaths: ['/etc/passwd'], pattern: 'needle' }, UNOPENED_ROOT)
    ).rejects.toThrow(/not inside any open folder/i);
    // Rejected before any disk work.
    expect(runLiveGrep).not.toHaveBeenCalled();
  });

  it('surfaces the scope error to the model rather than the generic fallback', async () => {
    // `Unable to perform grep search right now` would tell the model nothing and
    // invite a retry of the same broken call.
    await expect(
      runGrepSearchWith({ filePaths: ['/etc/passwd'], pattern: 'needle' }, UNOPENED_ROOT)
    ).rejects.toThrow(/Open folders:/);
    await expect(
      runGrepSearchWith({ filePaths: ['/etc/passwd'], pattern: 'needle' }, UNOPENED_ROOT)
    ).rejects.not.toThrow(/Try again/);
  });

  it('leaves a relative path untouched', async () => {
    const runtimeData = await diskWorkspace(
      [
        { content: 'needle', path: 'src/x.ts', start_line: 1 },
        { content: 'needle', path: 'src/y.ts', start_line: 1 },
      ],
      ONE_ROOT
    );
    const result = await runGrepSearchWith(
      { filePaths: ['src/x.ts'], pattern: 'needle' },
      runtimeData
    );
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files.map((file) => file.path)).toEqual(['src/x.ts']);
  });

  it('deduplicates an absolute and relative spelling of the same file', async () => {
    const runtimeData = await diskWorkspace(
      [{ content: 'needle', path: 'proof.html', start_line: 1 }],
      ONE_ROOT
    );
    const result = await runGrepSearchWith(
      {
        filePaths: [path.join(rootPathOf(runtimeData, 'db-root-a'), 'proof.html'), 'proof.html'],
        pattern: 'needle',
      },
      runtimeData
    );
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // One file, read once: its match is not counted twice.
    expect(result.files).toEqual([
      { firstLine: 1, matchCount: 1, path: 'proof.html', rootId: 'db-root-a', rootName: 'site-qa' },
    ]);
    expect(result.totalMatches).toBe(1);
  });

  it('rejects an ambiguous path under nested roots', async () => {
    await expect(
      runGrepSearchWith(
        { filePaths: ['/work/site-qa/inner/f.ts'], pattern: 'needle' },
        NESTED_ROOTS
      )
    ).rejects.toThrow(/more than one open folder/i);
  });

  it('uses an explicit root to disambiguate nested roots', async () => {
    const outer = await makeTemporaryDirectory();
    const inner = path.join(outer, 'inner');
    await writeRow(inner, { content: 'needle', path: 'f.ts', start_line: 1 });
    const runtimeData: RuntimeData = {
      workspaceRoots: [
        { displayName: 'outer', path: outer, rootId: 'db-root-a' },
        { displayName: 'inner', path: inner, rootId: 'db-root-b' },
      ],
    };

    const result = await runGrepSearchWith(
      { filePaths: [path.join(inner, 'f.ts')], pattern: 'needle', root: 'inner' },
      runtimeData
    );

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([
      { firstLine: 1, matchCount: 1, path: 'f.ts', rootId: 'db-root-b', rootName: 'inner' },
    ]);
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
  const SIBLING_ROOTS: readonly DiskRootSpec[] = [
    { displayName: 'A', rootId: 'db-root-a' },
    { displayName: 'B', rootId: 'db-root-b' },
  ];
  const SAME_NAMED_ROWS: readonly DiskGrepRow[] = [
    { content: 'needle', path: 'proof.html', root_id: 'db-root-a', start_line: 1 },
    { content: 'needle', path: 'proof.html', root_id: 'db-root-b', start_line: 1 },
  ];

  it('pins the search to the root the absolute path named', async () => {
    const runtimeData = await diskWorkspace(SAME_NAMED_ROWS, SIBLING_ROOTS);

    const result = await runGrepSearchWith(
      {
        filePaths: [path.join(rootPathOf(runtimeData, 'db-root-a'), 'proof.html')],
        pattern: 'needle',
      },
      runtimeData
    );

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    // B's identically-named file must not match a call that named A's.
    expect(result.files.map((file) => `${file.rootName}/${file.path}`)).toEqual(['A/proof.html']);
  });

  it('does not pin roots when the allowlist is purely relative', async () => {
    // A relative path carries no root information; narrowing it to one root
    // would be a silent scope reduction, the mirror of the widening bug.
    const runtimeData = await diskWorkspace(SAME_NAMED_ROWS, SIBLING_ROOTS);

    const result = await runGrepSearchWith(
      { filePaths: ['proof.html'], pattern: 'needle' },
      runtimeData
    );

    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files.map((file) => `${file.rootName}/${file.path}`).sort()).toEqual([
      'A/proof.html',
      'B/proof.html',
    ]);
  });
});
