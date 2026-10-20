/**
 * On-disk coverage for `brainstrike.grepSearch` (ADR 0026: grep is the core
 * lane and never asks Main's index).
 *
 * These cases run the REAL live pass against a temp-dir workspace: ripgrep or
 * JS-walk discovery, the shared JS matcher, the caps and their notes, end to
 * end. The point: the agent sees the files as they are now, including content
 * written a moment ago.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import { projectGrepSearchModelOutput } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearchWith } from '../../assistant-server/grep-search-core';
import {
  hasDotGitSegmentForTests,
  setMaxLiveCandidateFilesForTests,
} from '../../assistant-server/live-grep';
import { resetRipgrepAvailabilityForTests } from '../../assistant-server/live-grep-ripgrep';
import { singleRootRuntime } from './_tool-test-helpers';

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

function runGrepSearch(input: GrepSearchInput, runtimeData: RuntimeData) {
  return runGrepSearchWith(input, runtimeData);
}

beforeEach(() => {
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

describe('grepSearch — FRESHNESS (the point)', () => {
  it('fails visibly when a selected file cannot be read, never returning a partial result', async () => {
    const root = await makeWorkspace({ 'src/blocked.ts': 'TOKEN\n' });
    const canonicalBlocked = await fsPromises.realpath(path.join(root, 'src/blocked.ts'));
    const readFile = fsPromises.readFile.bind(fsPromises);
    const denied = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === canonicalBlocked) {
        throw Object.assign(new Error('selected read denied'), { code: 'EACCES' });
      }
      return readFile(...args);
    });
    try {
      await expect(
        runGrepSearch(
          { filePaths: ['src/blocked.ts'], outputMode: 'content', pattern: 'TOKEN' },
          singleRoot(root)
        )
      ).rejects.toThrow(/Unable to perform grep search/);
    } finally {
      denied.mockRestore();
    }
  });

  it('projects an exact-file live result with the direct-file engine', async () => {
    const root = await makeWorkspace({
      'src/fresh.ts': 'SCOPED_TOKEN\n',
      'src/unrelated.ts': 'SCOPED_TOKEN\n',
    });
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

  it('returns content written a moment ago', async () => {
    // A file the agent just edited or created; no index has seen it.
    const root = await makeWorkspace({
      'src/fresh.ts': 'const FRESHLY_EDITED_TOKEN = 42;\n',
    });

    const result = await runGrepSearch(
      { outputMode: 'content', pattern: 'FRESHLY_EDITED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/fresh.ts');
    expect(result.matches[0]?.lineText).toContain('FRESHLY_EDITED_TOKEN');
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

  it('files mode: a fresh file is surveyed', async () => {
    const root = await makeWorkspace({ 'a/only-on-disk.ts': 'WIDGET_BETA marker line\n' });

    const result = await runGrepSearch({ pattern: 'WIDGET_BETA' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('a/only-on-disk.ts');
    expect(projectGrepSearchModelOutput(result).value).toContain('grep files 1-1/1 matches=1');
    expect(projectGrepSearchModelOutput(result).value).toContain('a/only-on-disk.ts:1 (1 match)');
  });

  it('projects the producer zero-match variant without inventing a fallback result', async () => {
    const root = await makeWorkspace({ 'src/empty.ts': 'nothing relevant here\n' });

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

describe('grepSearch — rg-absent fallback (non-silent)', () => {
  it('falls back to the JS file-walk and still finds fresh content, with a note', async () => {
    const root = await makeWorkspace({ 'src/walked.ts': 'WALK_TOKEN present\n' });

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
      // The degradation is surfaced (never silent) and the engine is js-walk.
      expect(result.liveEngine).toBe('js-walk');
      expect(result.liveNote).toBeDefined();
      expect(result.liveNote).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('grepSearch — path containment (symlink escape)', () => {
  it('does not return a symlinked file whose target lives outside the root', async () => {
    const root = await makeWorkspace({ 'src/inside.ts': 'SECRET_TOKEN inside\n' });
    const outside = await makeWorkspace({ 'secret.ts': 'SECRET_TOKEN outside\n' });

    // Symlink (file) pointing OUTSIDE the root, and a symlinked DIR outside.
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'escape.ts'));
    await fsPromises.symlink(outside, path.join(root, 'linkdir'));

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

describe('grepSearch — candidate path filtering', () => {
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

describe('grepSearch — live caps surface in truncated (mode parity)', () => {
  /** Two matching files with a 1-file live candidate cap: the cap is hit and one on-disk match is unreached. */
  async function makeCappedWorkspace(): Promise<string> {
    setMaxLiveCandidateFilesForTests(1);
    const root = await makeWorkspace({
      'src/a.ts': 'CAP_TOKEN one\n',
      'src/b.ts': 'CAP_TOKEN two\n',
    });
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

describe('grepSearch — totalMatches across pages', () => {
  /** A file with more matches than one page shows. */
  const CAPPED_LINE_COUNT = 61;

  async function makePagedWorkspace(): Promise<string> {
    const lines = Array.from(
      { length: CAPPED_LINE_COUNT },
      (_unused, index) => `PAGED_TOKEN row ${index + 1}`
    );
    const content = `${lines.join('\n')}\n`;
    const root = await makeWorkspace({ 'docs/big.txt': content });
    return root;
  }

  it('reports the true match count when maxResults pages the result', async () => {
    const root = await makePagedWorkspace();

    const result = await runGrepSearch(
      { maxResults: 20, outputMode: 'content', pattern: 'PAGED_TOKEN' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    expect(result.matches).toHaveLength(20);
    expect(result.totalMatches).toBe(CAPPED_LINE_COUNT);
    expect(result.hint).toContain(`of ${CAPPED_LINE_COUNT}`);
  });

  it('reports the same total on the first page as on the last', async () => {
    // The reported total must not depend on where the caller is in the page
    // sequence. It once did (117 on page 1 vs 61 on the last), which made the
    // advertised total unusable.
    const root = await makePagedWorkspace();

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
});
