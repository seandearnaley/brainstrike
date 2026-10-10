/**
 * Hybrid (index + live) coverage for `brainstrike.grepSearch`.
 *
 * These cases run the REAL live (on-disk) pass against a temp-dir workspace
 * while mocking ONLY the DB (the index pass) — so they exercise the actual
 * ripgrep/JS-walk discovery, the shared JS matcher, and the merge/dedup/label
 * logic end to end. The point: prove the agent sees FRESH content the index
 * would miss after an edit, and that index + live matches merge correctly.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { projectGrepSearchModelOutput } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearch } from '../../assistant-server/grep-search-tool';
import {
  hasDotGitSegmentForTests,
  resetRipgrepAvailabilityForTests,
  setMaxLiveCandidateFilesForTests,
} from '../../assistant-server/live-grep';
import { singleRootRuntime } from './_tool-test-helpers';

const queryMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({ query: queryMock })),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-hybrid-grep-'));
  createdRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
  }
  return root;
}

function singleRoot(rootPath: string): RuntimeData {
  return singleRootRuntime(rootPath);
}

/** No indexed rows — the index pass returns zero matches. */
function indexEmpty(): void {
  queryMock.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  queryMock.mockReset();
  resetRipgrepAvailabilityForTests();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  setMaxLiveCandidateFilesForTests();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('grepSearch hybrid — FRESHNESS (the point)', () => {
  it('retains indexed matches with a visible stale-index note when a selected file cannot be read', async () => {
    const root = await makeWorkspace({ 'src/blocked.ts': 'TOKEN\n' });
    const canonicalBlocked = await fsPromises.realpath(path.join(root, 'src/blocked.ts'));
    queryMock.mockResolvedValue({
      rows: [{ content: 'TOKEN\n', path: 'src/blocked.ts', start_line: 1 }],
    });
    const readFile = fsPromises.readFile.bind(fsPromises);
    const denied = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === canonicalBlocked) {
        throw Object.assign(new Error('selected read denied'), { code: 'EACCES' });
      }
      return readFile(...args);
    });
    try {
      const result = await runGrepSearch(
        { filePaths: ['src/blocked.ts'], outputMode: 'content', pattern: 'TOKEN' },
        singleRoot(root)
      );
      if (result.outputMode !== 'content') {
        throw new Error('expected content result');
      }
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({ path: 'src/blocked.ts', source: 'index' });
      expect(result.liveEngine).toBe('skipped');
      expect(result.liveNote).toMatch(/index only.*may be stale/);
      expect(projectGrepSearchModelOutput(result).value).toMatch(/index only.*may be stale/);
    } finally {
      denied.mockRestore();
    }
  });

  it('projects an exact-file live result with the direct-file engine', async () => {
    const root = await makeWorkspace({
      'src/fresh.ts': 'SCOPED_TOKEN\n',
      'src/unrelated.ts': 'SCOPED_TOKEN\n',
    });
    indexEmpty();
    const result = await runGrepSearch(
      { filePaths: ['src/fresh.ts'], outputMode: 'content', pattern: 'SCOPED_TOKEN' },
      singleRoot(root)
    );
    expect(result.liveEngine).toBe('js-files');
    expect(result.liveNote).toBeUndefined();
    const projection = projectGrepSearchModelOutput(result).value;
    expect(projection).toContain('src/fresh.ts');
    expect(projection).not.toContain('src/unrelated.ts');
  });

  it('returns just-written content the index does NOT have, labelled live', async () => {
    // A file that exists on disk but is NOT in the index (simulating a file the
    // agent just edited/created before re-indexing caught up).
    const root = await makeWorkspace({
      'src/fresh.ts': 'const FRESHLY_EDITED_TOKEN = 42;\n',
    });
    indexEmpty(); // index has NOTHING for this token

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'FRESHLY_EDITED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }

    // The index missed it entirely; the LIVE pass found it fresh on disk.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/fresh.ts');
    expect(result.matches[0]?.lineText).toContain('FRESHLY_EDITED_TOKEN');
    expect(result.matches[0]?.source).toBe('live');
    // The live pass RAN (not 'skipped'). The exact engine — ripgrep when `rg` is
    // installed, the JS walk otherwise — is an environment detail (CI runners
    // lack rg) and both yield identical matches. The js-walk fallback is pinned
    // in its own dedicated test below; here we only assert the live pass ran.
    expect(result.liveEngine).not.toBe('skipped');
    // End-to-end format regression (BST-1185): real tool result → compact
    // path-grouped projection, no per-row envelope, silent happy-path header.
    // The live engine is an environment detail (CI runners lack rg): ripgrep
    // yields a fully silent header; the js-walk fallback surfaces exactly its
    // own degradation flag and nothing else.
    const projected = projectGrepSearchModelOutput(result).value;
    expect(projected.split('\n')[0]).toMatch(/^grep content 1-1\/1( \| live=js-walk)?$/);
    expect(projected).toContain('src/fresh.ts');
    expect(projected).toContain('  1: const FRESHLY_EDITED_TOKEN = 42;');
    expect(projected).not.toContain('read_args=');
    expect(projected).not.toContain('source=');
    expect(projected).not.toContain('candidates_truncated');
  });

  it('files mode: a fresh-only file is surveyed and labelled live', async () => {
    const root = await makeWorkspace({ 'a/only-on-disk.ts': 'WIDGET_BETA marker line\n' });
    indexEmpty();

    const result = await runGrepSearch({ pattern: 'WIDGET_BETA' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('a/only-on-disk.ts');
    expect(result.files[0]?.source).toBe('live');
    expect(projectGrepSearchModelOutput(result).value).toContain('grep files 1-1/1 matches=1');
    expect(projectGrepSearchModelOutput(result).value).toContain('a/only-on-disk.ts:1 (1 match)');
  });

  it('projects the producer zero-match variant without inventing a fallback result', async () => {
    const root = await makeWorkspace({ 'src/empty.ts': 'nothing relevant here\n' });
    indexEmpty();

    const result = await runGrepSearch({ pattern: 'ABSENT_TOKEN' }, singleRoot(root));

    expect(result).toMatchObject({
      files: [],
      outputMode: 'files',
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });
    expect(projectGrepSearchModelOutput(result).value).toContain('grep files empty@offset=0/0');
  });
});

describe('grepSearch hybrid — merge / dedup / label', () => {
  it('labels a line found in BOTH index and live as "both" (counted once)', async () => {
    const root = await makeWorkspace({ 'src/x.ts': 'shared NEEDLE here\n' });
    // The index ALSO has the exact same (path, line) — startLine 1 → line 1.
    queryMock.mockResolvedValue({
      rows: [{ content: 'shared NEEDLE here', path: 'src/x.ts', start_line: 1 }],
    });

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'NEEDLE' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // ONE merged match, labelled both.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/x.ts');
    expect(result.matches[0]?.line).toBe(1);
    expect(result.matches[0]?.source).toBe('both');
    expect(result.totalMatches).toBe(1);
  });

  it('labels index-only and live-only matches distinctly in one result', async () => {
    // On disk: only fresh.ts has the token. Index: only stale.ts (no longer on
    // disk for that token) reports a match — an index-only hit.
    const root = await makeWorkspace({ 'src/fresh.ts': 'TOKEN on disk\n' });
    queryMock.mockResolvedValue({
      rows: [{ content: 'TOKEN in index', path: 'src/stale.ts', start_line: 7 }],
    });

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    const bySource = new Map(result.matches.map((m) => [m.path, m.source]));
    expect(bySource.get('src/fresh.ts')).toBe('live');
    expect(bySource.get('src/stale.ts')).toBe('index');
    expect(result.matches).toHaveLength(2);
  });
});

describe('grepSearch hybrid — rg-absent fallback (non-silent)', () => {
  it('falls back to the JS file-walk and still finds fresh content, with a note', async () => {
    const root = await makeWorkspace({ 'src/walked.ts': 'WALK_TOKEN present\n' });
    indexEmpty();

    // Force ripgrep "absent": the probe stats the rg binary path, so make that
    // one stat throw (ENOENT) while every other stat behaves normally.
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && ['rg', 'rg.exe'].includes(path.basename(target))) {
          throw new Error('ENOENT: ripgrep not found');
        }
        return realStat(target);
      });

    try {
      const result = await runGrepSearch(
        { outputMode: 'content', pattern: 'WALK_TOKEN' },
        singleRoot(root)
      );
      if (result.outputMode !== 'content') {
        throw new Error('expected content result');
      }
      // The fallback walk still found the fresh content.
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.path).toBe('src/walked.ts');
      expect(result.matches[0]?.source).toBe('live');
      // The degradation is surfaced (never silent) and the engine is js-walk.
      expect(result.liveEngine).toBe('js-walk');
      expect(result.liveNote).toBeDefined();
      expect(result.liveNote).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('grepSearch hybrid — path containment (symlink escape)', () => {
  it('does not return a symlinked file whose target lives outside the root', async () => {
    const root = await makeWorkspace({ 'src/inside.ts': 'SECRET_TOKEN inside\n' });
    const outside = await makeWorkspace({ 'secret.ts': 'SECRET_TOKEN outside\n' });

    // Symlink (file) pointing OUTSIDE the root, and a symlinked DIR outside.
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'escape.ts'));
    await fsPromises.symlink(outside, path.join(root, 'linkdir'));
    indexEmpty();

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'SECRET_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // Only the in-root file is returned; the escaping symlink is dropped.
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain('src/inside.ts');
    expect(paths).not.toContain('src/escape.ts');
    expect(paths.some((p) => p.includes('secret.ts'))).toBe(false);
  });
});

describe('grepSearch hybrid — candidate path filtering', () => {
  it('detects exact .git path segments without splitting candidate paths', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(hasDotGitSegmentForTests('.git/config')).toBe(true);
      expect(hasDotGitSegmentForTests('src/.git/hooks/pre-commit')).toBe(true);
      expect(hasDotGitSegmentForTests('src/.github/workflows/ci.yml')).toBe(false);
      expect(hasDotGitSegmentForTests('src/.gitignore')).toBe(false);
      expect(hasDotGitSegmentForTests('src/git/config')).toBe(false);

      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });
});

describe('grepSearch hybrid — live caps surface in truncated (mode parity)', () => {
  /** Two matching files with a 1-file live candidate cap: the cap is hit and one on-disk match is unreached. */
  async function makeCappedWorkspace(): Promise<string> {
    setMaxLiveCandidateFilesForTests(1);
    const root = await makeWorkspace({
      'src/a.ts': 'CAP_TOKEN one\n',
      'src/b.ts': 'CAP_TOKEN two\n',
    });
    indexEmpty();
    return root;
  }

  it('content mode surfaces the live candidate cap as candidatesTruncated with terminal guidance', async () => {
    const root = await makeCappedWorkspace();

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'CAP_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // Only the capped candidate's match is counted, so pagination looks
    // "complete" — but the live cap left an on-disk match unreached. BST-1247:
    // that is a SUBSTRATE condition, so it surfaces as candidatesTruncated
    // (never folded into `truncated`, which now means output clipping only),
    // with the SAME terminal guidance (the hint gate unions all three flags).
    expect(result.matches).toHaveLength(1);
    expect(result.totalMatches).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.candidatesTruncated).toBe(true);
    expect(result.liveNote).toMatch(/candidate-file cap/i);
    expect(result.hint).toMatch(/narrow|different|specific/i);
    expect(result.hint).not.toContain('Continue with offset:');
    expect(projectGrepSearchModelOutput(result).value).toContain('continue:');
  });

  it('files mode reports the same candidatesTruncated for the same capped live pass', async () => {
    const root = await makeCappedWorkspace();

    const result = await runGrepSearch({ pattern: 'CAP_TOKEN' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.candidatesTruncated).toBe(true);
    expect(result.liveNote).toMatch(/candidate-file cap/i);
    expect(result.hint).toBeDefined();
    expect(projectGrepSearchModelOutput(result).value).toContain('continue:');
  });
});

describe('grepSearch hybrid — totalMatches when the index pass is capped', () => {
  /**
   * A file whose matches exceed the per-call index materialization cap, indexed
   * and on disk with IDENTICAL content — the ordinary case for any pattern with
   * more hits than `maxResults`.
   *
   * The index arm reports its UNCAPPED unique count in `totalMatches` but
   * materializes only `offset + maxResults` rows. Live-only counting must not
   * treat the unmaterialized remainder as newly-discovered lines, or the same
   * physical line is counted twice: once inside the index total, once as a
   * "live-only" addition.
   */
  const CAPPED_LINE_COUNT = 61;

  async function makeIndexCappedWorkspace(): Promise<string> {
    const lines = Array.from(
      { length: CAPPED_LINE_COUNT },
      (_unused, index) => `PAGED_TOKEN row ${index + 1}`
    );
    const content = `${lines.join('\n')}\n`;
    const root = await makeWorkspace({ 'docs/big.txt': content });
    // The index holds the SAME file content, so every on-disk match also exists
    // in the index — the merged set is exactly CAPPED_LINE_COUNT lines.
    queryMock.mockResolvedValue({
      rows: [{ content, path: 'docs/big.txt', start_line: 1 }],
    });
    return root;
  }

  it('reports the true match count when maxResults caps the index pass', async () => {
    const root = await makeIndexCappedWorkspace();

    const result = await runGrepSearch(
      { maxResults: 20, outputMode: 'content', pattern: 'PAGED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    expect(result.matches).toHaveLength(20);
    // Every returned line exists in BOTH passes; none is a live-only discovery.
    expect(result.matches.every((match) => match.source === 'both')).toBe(true);
    expect(result.totalMatches).toBe(CAPPED_LINE_COUNT);
    expect(result.hint).toContain(`of ${CAPPED_LINE_COUNT}`);
  });

  it('reports the same total on the first page as on the last', async () => {
    // The two pages are deliberately NOT symmetric: only the page SIZE differs,
    // and both now request the same internal cap from the index arm, so this
    // pins that the reported total is independent of where the caller is in the
    // page sequence. Before the fix these disagreed (117 on page 1 vs 61 on the
    // last), which is what made the advertised total unusable.
    const root = await makeIndexCappedWorkspace();

    const firstPage = await runGrepSearch(
      { maxResults: 5, offset: 0, outputMode: 'content', pattern: 'PAGED_TOKEN' },
      singleRoot(root)
    );
    const lastPage = await runGrepSearch(
      {
        maxResults: 5,
        offset: CAPPED_LINE_COUNT - 3,
        outputMode: 'content',
        pattern: 'PAGED_TOKEN',
      },
      singleRoot(root)
    );
    if (firstPage.outputMode !== 'content' || lastPage.outputMode !== 'content') {
      throw new Error('expected content results');
    }
    // A total that shrinks as the caller pages through is a total the caller
    // cannot act on: page 1 advertises matches that paging can never reach.
    expect(firstPage.totalMatches).toBe(lastPage.totalMatches);
    expect(firstPage.totalMatches).toBe(CAPPED_LINE_COUNT);
  });

  it('counts fresh live-only lines even when the merged set is SMALLER than the index total', async () => {
    // The lossy shape both PR #2233 reviewers identified. The index counts more
    // than the live pass can see — a STALE index (the file has since been
    // trimmed on disk) is the cheapest way to produce it, but the live pass's
    // own caps (per-file --max-count, --max-filesize, the candidate cap) reach
    // the same state on a fresh index.
    //
    // Here the merged set stays well BELOW `indexResult.totalMatches`, so any
    // total derived only from the index count silently absorbs the genuinely
    // fresh, live-only file — the exact over-correction a `max()` of the two
    // floors would make. Pinned so nobody "simplifies" it back.
    const indexedContent = `${Array.from(
      { length: CAPPED_LINE_COUNT },
      (_unused, index) => `PAGED_TOKEN row ${index + 1}`
    ).join('\n')}\n`;
    const root = await makeWorkspace({
      // On disk the file now holds only the first 5 of the indexed lines...
      'docs/big.txt': `${Array.from({ length: 5 }, (_unused, index) => `PAGED_TOKEN row ${index + 1}`).join('\n')}\n`,
      // ...and this file is on disk ONLY — the index has never seen it.
      'src/fresh.ts': 'const PAGED_TOKEN = "brand new";\n',
    });
    queryMock.mockResolvedValue({
      rows: [{ content: indexedContent, path: 'docs/big.txt', start_line: 1 }],
    });

    const result = await runGrepSearch(
      { maxResults: 5, outputMode: 'content', pattern: 'PAGED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // The fresh file is a CONFIRMED location neither pass can double-count, so
    // it must appear in the total. (It sorts after `docs/`, so it lands on a
    // later page rather than this one — that is paging, not counting.)
    expect(result.totalMatches).toBe(CAPPED_LINE_COUNT + 1);
  });

  it('still counts genuinely fresh live-only lines on top of the index total', async () => {
    // Index is capped AND the disk has an extra line the index does not hold:
    // the live-only line is a real discovery and must still be counted.
    const root = await makeIndexCappedWorkspace();
    await fsPromises.appendFile(
      path.join(root, 'docs', 'big.txt'),
      'PAGED_TOKEN freshly appended\n',
      'utf8'
    );

    const result = await runGrepSearch(
      { maxResults: 5, outputMode: 'content', pattern: 'PAGED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    expect(result.totalMatches).toBe(CAPPED_LINE_COUNT + 1);
  });
});

describe('grepSearch hybrid — index unavailable but live works', () => {
  it('returns live-only results when the workspace is not indexed', async () => {
    const root = await makeWorkspace({ 'main.ts': 'UNINDEXED_MARKER value\n' });
    // Model an un-indexed workspace: the index pass returns nothing, so the
    // live pass is the SOLE source — grep still works without an index.
    indexEmpty();

    const result = await runGrepSearch({ pattern: 'UNINDEXED_MARKER' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('main.ts');
    expect(result.files[0]?.source).toBe('live');
    expect(result.totalMatches).toBe(1);
  });
});
