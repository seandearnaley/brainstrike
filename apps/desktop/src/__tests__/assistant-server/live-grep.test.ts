/**
 * Unit coverage for the desktop LIVE grep pass (`runLiveGrep`). Exercises the
 * real on-disk discovery (ripgrep + JS-walk fallback), the shared JS matcher,
 * the ignore policy, multi-root scoping, and the symlink-containment discipline
 * against temp-dir workspaces — no DB, no agent loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRipgrepAvailabilityForTests, runLiveGrep } from '../../assistant-server/live-grep';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
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

async function makeWorkspace(
  files: Record<string, string>,
  prefix = 'brainstrike-livegrep-'
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
  return { rootId: id, displayName: name, path: rootPath };
}

function literalMatcher(pattern: string): ReturnType<typeof createGrepLineMatcher> {
  return createGrepLineMatcher(pattern, false, false);
}

beforeEach(() => {
  resetRipgrepAvailabilityForTests();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('runLiveGrep — basics', () => {
  it('skips (engine: skipped) when no roots are supplied', async () => {
    const result = await runLiveGrep(
      {
        pattern: 'x',
        isRegex: false,
        caseSensitive: false,
        contextLines: 0,
        roots: [],
      },
      literalMatcher('x')
    );
    expect(result.engine).toBe('skipped');
    expect(result.matches).toEqual([]);
  });

  it('finds on-disk matches with the ripgrep engine and labels their root', async () => {
    const dir = await makeWorkspace({
      'src/a.ts': 'alpha\nLIVE_MARKER here\nbeta\n',
      'src/b.ts': 'no match here\n',
    });
    const result = await runLiveGrep(
      {
        pattern: 'LIVE_MARKER',
        isRegex: false,
        caseSensitive: false,
        contextLines: 1,
        roots: [root(dir, 'id-a', 'alpha-root')],
      },
      literalMatcher('LIVE_MARKER')
    );
    expect(result.engine).toBe('ripgrep');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/a.ts');
    expect(result.matches[0]?.line).toBe(2);
    expect(result.matches[0]?.before).toEqual(['alpha']);
    expect(result.matches[0]?.after).toEqual(['beta']);
    expect(result.matches[0]?.rootId).toBe('id-a');
    expect(result.matches[0]?.rootName).toBe('alpha-root');
    expect(result.note).toBeUndefined();
  });

  it('respects the ignore policy (skips node_modules and build output)', async () => {
    const dir = await makeWorkspace({
      'src/keep.ts': 'IGNORE_PROBE keep\n',
      'node_modules/dep/index.ts': 'IGNORE_PROBE dep\n',
      'dist/bundle.ts': 'IGNORE_PROBE bundle\n',
    });
    const result = await runLiveGrep(
      {
        pattern: 'IGNORE_PROBE',
        isRegex: false,
        caseSensitive: false,
        contextLines: 0,
        roots: [root(dir)],
      },
      literalMatcher('IGNORE_PROBE')
    );
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
  });

  it('scopes each root and labels matches across multiple roots', async () => {
    const dirA = await makeWorkspace({ 'a.ts': 'MULTI here\n' }, 'brainstrike-livegrep-a-');
    const dirB = await makeWorkspace({ 'b.ts': 'MULTI there\n' }, 'brainstrike-livegrep-b-');
    const result = await runLiveGrep(
      {
        pattern: 'MULTI',
        isRegex: false,
        caseSensitive: false,
        contextLines: 0,
        roots: [root(dirA, 'id-a', 'alpha'), root(dirB, 'id-b', 'beta')],
      },
      literalMatcher('MULTI')
    );
    const labelled = result.matches.map((m) => `${m.rootName}/${m.path}`).sort();
    expect(labelled).toEqual(['alpha/a.ts', 'beta/b.ts']);
  });
});

describe('runLiveGrep — rg-absent fallback (non-silent)', () => {
  it('uses the JS file-walk and emits a note when ripgrep is unavailable', async () => {
    const dir = await makeWorkspace({ 'src/walk.ts': 'WALKING_TOKEN line\n' });

    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && target.endsWith('/rg')) {
          throw new Error('ENOENT: no ripgrep');
        }
        return realStat(target);
      });

    try {
      const result = await runLiveGrep(
        {
          pattern: 'WALKING_TOKEN',
          isRegex: false,
          caseSensitive: false,
          contextLines: 0,
          roots: [root(dir)],
        },
        literalMatcher('WALKING_TOKEN')
      );
      expect(result.engine).toBe('js-walk');
      expect(result.matches.map((m) => m.path)).toEqual(['src/walk.ts']);
      expect(result.note).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('runLiveGrep — path containment (symlink escape)', () => {
  it('does not follow a symlink whose target lives outside the root', async () => {
    const dir = await makeWorkspace({ 'src/inside.ts': 'ESCAPE_PROBE inside\n' });
    const outside = await makeWorkspace(
      { 'secret.ts': 'ESCAPE_PROBE outside\n' },
      'brainstrike-livegrep-out-'
    );
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(dir, 'src', 'escape.ts'));
    await fsPromises.symlink(outside, path.join(dir, 'linkdir'));

    const result = await runLiveGrep(
      {
        pattern: 'ESCAPE_PROBE',
        isRegex: false,
        caseSensitive: false,
        contextLines: 0,
        roots: [root(dir)],
      },
      literalMatcher('ESCAPE_PROBE')
    );
    const paths = result.matches.map((m) => m.path);
    expect(paths).toEqual(['src/inside.ts']);
    expect(paths.some((p) => p.includes('secret') || p.includes('escape'))).toBe(false);
  });
});

describe('runLiveGrep — regex + filePaths scoping', () => {
  it('matches a regex pattern via the shared matcher', async () => {
    const dir = await makeWorkspace({ 'src/r.ts': 'value = REGEX_42 end\n' });
    const result = await runLiveGrep(
      {
        pattern: 'REGEX_\\d+',
        isRegex: true,
        caseSensitive: false,
        contextLines: 0,
        roots: [root(dir)],
      },
      createGrepLineMatcher('REGEX_\\d+', true, false)
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineText).toContain('REGEX_42');
  });

  it('restricts matches to the filePaths allowlist', async () => {
    const dir = await makeWorkspace({
      'src/keep.ts': 'ALLOW_PROBE keep\n',
      'src/drop.ts': 'ALLOW_PROBE drop\n',
    });
    const result = await runLiveGrep(
      {
        pattern: 'ALLOW_PROBE',
        isRegex: false,
        caseSensitive: false,
        contextLines: 0,
        roots: [root(dir)],
        filePaths: ['src/keep.ts'],
      },
      literalMatcher('ALLOW_PROBE')
    );
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
  });
});
