/**
 * Live-grep coverage for the HARD agent ignore layers (BST-1432). Split out of
 * `live-grep.integration.test.ts` to keep both files under the repo's
 * noExcessiveLinesPerFile cap (Biome enforces it), so new coverage gets its own
 * file rather than a grandfathered exemption.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRipgrepAvailabilityForTests, runLiveGrep } from '../../assistant-server/live-grep';
import { discoverRipgrepPathForTests, runRipgrep } from '../../assistant-server/live-grep-ripgrep';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

const createdRoots: string[] = [];
const originalPath = process.env['PATH'];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-agent-'));
  createdRoots.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
  }
  return dir;
}

function root(rootPath: string, id = 'root-1', name = 'workspace'): RuntimeWorkspaceRoot {
  return { displayName: name, path: rootPath, rootId: id };
}

function literalMatcher(pattern: string): ReturnType<typeof createGrepLineMatcher> {
  return createGrepLineMatcher(pattern, false, false);
}

/** Run `fn` with ripgrep forced UNAVAILABLE, so the JS-walk engine is exercised. */
async function withRipgrepHidden<T>(fn: () => Promise<T>): Promise<T> {
  const emptyBin = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-nobin-'));
  createdRoots.push(emptyBin);
  const realStat = fsPromises.stat;
  const statSpy = vi
    .spyOn(fsPromises, 'stat')
    .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
      if (/[/\\]rg(\.exe)?$/.test(String(target))) {
        throw new Error('ENOENT');
      }
      return await realStat(target);
    });
  process.env['PATH'] = emptyBin;
  resetRipgrepAvailabilityForTests();
  try {
    return await fn();
  } finally {
    statSpy.mockRestore();
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

beforeEach(() => {
  resetRipgrepAvailabilityForTests();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  process.env['PATH'] = originalPath;
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

describe('runLiveGrep — agent ignore files (BST-1432)', () => {
  /**
   * The hard boundary has to hold on EVERY read path, not just glob. A
   * `.llmignore` that hides a credentials file from the file lister while grep
   * happily returns its contents is not a boundary — it is a UI convenience
   * that reads as a security control, which is the worse of the two failures.
   *
   * Asserted against BOTH engines because live grep has two independent
   * candidate collectors (ripgrep and the JS walk fallback), and an exclusion
   * enforced in only one of them holds or fails depending on whether `rg`
   * happens to be installed on the machine.
   *
   * Note the asymmetry with `.gitignore` (BST-1429): rg implements gitignore
   * natively, so pushing that layer down to rg risks the two engines
   * disagreeing on edge cases. `.llmignore` is not an rg ignore file at all, so
   * JS-side enforcement on both collectors is the ONLY implementation — there
   * is no second implementation to diverge from.
   */
  const workspace = {
    '.llmignore': 'secrets/\n',
    'secrets/creds.ts': 'const key = "LLMIGNORE_MARKER";\n',
    'src/ok.ts': 'const note = "LLMIGNORE_MARKER";\n',
  };

  it('does not read through an in-root SYMLINK to an agent-ignored target', async () => {
    // The candidate carries the LINK's relative path and the TARGET's absolute
    // path; filtering on the former lets an alias launder the excluded file's
    // CONTENT into the transcript, which is the exact thing the boundary sells.
    const dir = await makeWorkspace({
      '.llmignore': 'secrets/\n',
      'docs/real.md': 'nothing here\n',
      'secrets/creds.ts': 'const key = "SYMLINK_MARKER";\n',
    });
    await fsPromises.symlink(
      path.join(dir, 'secrets', 'creds.ts'),
      path.join(dir, 'docs', 'alias.ts')
    );

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'SYMLINK_MARKER',
        roots: [root(dir)],
      },
      literalMatcher('SYMLINK_MARKER')
    );

    expect(result.matches).toEqual([]);
  });

  it('does not read through an in-root SYMLINK on the JS-walk engine either', async () => {
    // Asserted on this engine SPECIFICALLY: ripgrep does not follow symlinks
    // without -L, so the rg case above passes whether or not the JS walk is
    // fixed. Only the walk engine actually exercises the alias filter, which
    // makes this the non-vacuous half of the pair.
    const dir = await makeWorkspace({
      '.llmignore': 'secrets/\n',
      'docs/real.md': 'nothing here\n',
      'secrets/creds.ts': 'const key = "SYMLINK_MARKER";\n',
    });
    await fsPromises.symlink(
      path.join(dir, 'secrets', 'creds.ts'),
      path.join(dir, 'docs', 'alias.ts')
    );

    const result = await withRipgrepHidden(() =>
      runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'SYMLINK_MARKER',
          roots: [root(dir)],
        },
        literalMatcher('SYMLINK_MARKER')
      )
    );

    expect(result.matches).toEqual([]);
  });

  it('excludes .llmignore paths on the ripgrep engine', async () => {
    const dir = await makeWorkspace(workspace);
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'LLMIGNORE_MARKER',
        roots: [root(dir)],
      },
      literalMatcher('LLMIGNORE_MARKER')
    );
    expect(result.matches.map((match) => match.path)).toEqual(['src/ok.ts']);
  });

  // 2026-10-16: the match was the comment above the key, and one line of
  // context carried a gitignored `.env.local` API key into the transcript.
  const credentialed = {
    '.env.example': '# First live enrichment experiment\nTYPESAFE_API_KEY=\n',
    '.env.local': '# First live enrichment experiment\nTYPESAFE_API_KEY=sk-live-SECRET\n',
    '.gitignore': '.env.local\n',
    'certs/tls.key': 'enrichment PRIVATE-KEY-SECRET\n',
    'src/enrich.ts': 'export const enrichment = true;\n',
  };
  const grepCredentialed = (dir: string) =>
    runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 1,
        isRegex: false,
        pattern: 'enrichment',
        roots: [root(dir)],
      },
      literalMatcher('enrichment')
    );

  it('never searches credential files on the ripgrep engine, gitignored or not', async () => {
    const dir = await makeWorkspace(credentialed);
    const result = await grepCredentialed(dir);
    expect(result.matches.map((match) => match.path).sort()).toEqual([
      '.env.example',
      'src/enrich.ts',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it('keeps credential files out of ripgrep itself, so they never read or spend its cap', async () => {
    const ripgrepPath = await discoverRipgrepPathForTests();
    expect(ripgrepPath).not.toBeNull();
    const dir = await makeWorkspace(credentialed);
    const run = await runRipgrep({
      canonicalRootPath: dir,
      caseSensitive: false,
      prefilterLiteral: 'enrichment',
      ripgrepPath: ripgrepPath ?? '',
    });
    expect([...run.candidatePaths].sort()).toEqual(['.env.example', 'src/enrich.ts']);
  });

  it('never searches credential files on the JS-walk engine either', async () => {
    const dir = await makeWorkspace(credentialed);
    const result = await withRipgrepHidden(() => grepCredentialed(dir));
    expect(result.matches.map((match) => match.path).sort()).toEqual([
      '.env.example',
      'src/enrich.ts',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it('excludes .llmignore paths on the JS-walk engine', async () => {
    const dir = await makeWorkspace(workspace);
    const result = await withRipgrepHidden(() =>
      runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'LLMIGNORE_MARKER',
          roots: [root(dir)],
        },
        literalMatcher('LLMIGNORE_MARKER')
      )
    );
    expect(result.matches.map((match) => match.path)).toEqual(['src/ok.ts']);
  });
});
