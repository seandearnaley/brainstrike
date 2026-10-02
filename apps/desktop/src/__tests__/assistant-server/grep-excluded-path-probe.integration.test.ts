/**
 * Unit coverage for `probeExcludedPathMatches` (BST-1194's excluded-path
 * zero-match steering probe): ripgrep-only, count-only matching inside
 * normally-excluded paths (node_modules, etc.), the `.git` containment guard,
 * the ripgrep-unavailable fallback, and the `filePaths` allowlist. Split out
 * of live-grep.integration.test.ts to keep both files under the repo's
 * noExcessiveLinesPerFile cap (Biome enforces it), so new coverage gets its own
 * file rather than a grandfathered exemption.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverRipgrepPathForTests,
  probeExcludedPathMatches,
  resetRipgrepAvailabilityForTests,
} from '../../assistant-server/live-grep';

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

const createdRoots: string[] = [];

async function makeWorkspace(
  files: Record<string, string>,
  prefix = 'brainstrike-excluded-probe-'
): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  createdRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
  }
  return root;
}

function root(rootPath: string, id = 'root-1', name = 'workspace'): RuntimeWorkspaceRoot {
  return { displayName: name, path: rootPath, rootId: id };
}

function literalMatcher(pattern: string): ReturnType<typeof createGrepLineMatcher> {
  return createGrepLineMatcher(pattern, false, false);
}

const originalPath = process.env['PATH'];

beforeEach(() => {
  resetRipgrepAvailabilityForTests();
  loggerWarnMock.mockReset();
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

/**
 * Run `fn` with ripgrep forced UNAVAILABLE: an empty PATH bin dir plus a stat
 * shim that misses every `.../rg(.exe)` probe (PATH and the hardcoded fallback
 * dirs alike), so the probe's rg resolution comes back null. Restores PATH +
 * the stat spy afterwards.
 */
async function withRipgrepHidden<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'brainstrike-excluded-probe-hide-')
  );
  createdRoots.push(binDir);
  process.env['PATH'] = binDir;
  const realStat = fsPromises.stat.bind(fsPromises);
  const statSpy = vi
    .spyOn(fsPromises, 'stat')
    .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
      if (typeof target === 'string' && (target.endsWith('/rg') || target.endsWith('\\rg.exe'))) {
        throw new Error('ENOENT: ripgrep hidden for test');
      }
      return realStat(target);
    });
  resetRipgrepAvailabilityForTests();
  try {
    return await fn();
  } finally {
    statSpy.mockRestore();
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

const probeRipgrepAvailable = (await discoverRipgrepPathForTests()) !== null;

describe('probeExcludedPathMatches', () => {
  it.skipIf(!probeRipgrepAvailable)(
    'still respects .llmignore, the one exclusion it may not steer past (BST-1432)',
    async () => {
      // This probe exists to look INSIDE normally-excluded trees, so it is the
      // read path most likely to walk straight through an agent ignore file.
      // Its whole job is bypassing exclusions; the hard boundary is the single
      // exclusion that must survive that, or `.llmignore` means nothing on the
      // one code path that goes looking where nothing else does.
      const dir = await makeWorkspace({
        '.llmignore': 'node_modules/secret/\n',
        'node_modules/dep/index.ts': 'PROBE_HARD one\n',
        'node_modules/secret/creds.ts': 'PROBE_HARD two\nPROBE_HARD three\n',
      });

      const result = await probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'PROBE_HARD',
          roots: [root(dir)],
        },
        literalMatcher('PROBE_HARD')
      );

      expect(result).toEqual({
        examplePaths: ['node_modules/dep/index.ts'],
        matchCount: 1,
      });
    }
  );

  it.skipIf(!probeRipgrepAvailable)(
    'counts matches inside node_modules, which the normal passes exclude',
    async () => {
      const dir = await makeWorkspace({
        'node_modules/dep/index.ts': 'EXCLUDED_PROBE one\nEXCLUDED_PROBE two\n',
      });

      const result = await probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'EXCLUDED_PROBE',
          roots: [root(dir)],
        },
        literalMatcher('EXCLUDED_PROBE')
      );

      expect(result).toEqual({
        examplePaths: ['node_modules/dep/index.ts'],
        matchCount: 2,
      });
    }
  );

  it.skipIf(!probeRipgrepAvailable)(
    'does not count matches in normally included files',
    async () => {
      const dir = await makeWorkspace({ 'src/normal.ts': 'EXCLUDED_NORMAL match\n' });

      const result = await probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'EXCLUDED_NORMAL',
          roots: [root(dir)],
        },
        literalMatcher('EXCLUDED_NORMAL')
      );

      expect(result).toEqual({ matchCount: 0 });
    }
  );

  it.skipIf(!probeRipgrepAvailable)(
    'never descends into .git even when probing excluded paths',
    async () => {
      const dir = await makeWorkspace({ '.git/objects/probe.txt': 'DOT_GIT_PROBE match\n' });

      const result = await probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'DOT_GIT_PROBE',
          roots: [root(dir)],
        },
        literalMatcher('DOT_GIT_PROBE')
      );

      expect(result).toEqual({ matchCount: 0 });
    }
  );

  it('returns a clean miss when ripgrep is unavailable', async () => {
    const dir = await makeWorkspace({
      'node_modules/dep/index.ts': 'NO_RIPGREP_PROBE match\n',
    });

    const result = await withRipgrepHidden(() =>
      probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'NO_RIPGREP_PROBE',
          roots: [root(dir)],
        },
        literalMatcher('NO_RIPGREP_PROBE')
      )
    );

    expect(result).toEqual({ matchCount: 0 });
  });

  it.skipIf(!probeRipgrepAvailable)(
    'respects the exact filePaths allowlist for excluded candidates',
    async () => {
      const dir = await makeWorkspace({
        'node_modules/drop/index.ts': 'ALLOW_EXCLUDED match\n',
        'node_modules/keep/index.ts': 'ALLOW_EXCLUDED match\n',
      });
      const options = {
        caseSensitive: false,
        isRegex: false,
        pattern: 'ALLOW_EXCLUDED',
        roots: [root(dir)],
      };

      const notAllowed = await probeExcludedPathMatches(
        { ...options, filePaths: ['node_modules/missing/index.ts'] },
        literalMatcher('ALLOW_EXCLUDED')
      );
      const allowed = await probeExcludedPathMatches(
        { ...options, filePaths: ['node_modules/keep/index.ts'] },
        literalMatcher('ALLOW_EXCLUDED')
      );

      expect(notAllowed).toEqual({ matchCount: 0 });
      expect(allowed).toEqual({
        examplePaths: ['node_modules/keep/index.ts'],
        matchCount: 1,
      });
    }
  );
});
