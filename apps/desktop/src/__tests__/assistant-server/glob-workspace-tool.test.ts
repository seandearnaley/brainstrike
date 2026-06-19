/**
 * Unit coverage for the desktop `brainstrike.globWorkspace` tool
 * (`runGlobWorkspace`). Exercises the real FS walk + real ignore policy + real
 * path containment against temp-dir workspaces — no DB, no agent loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGlobWorkspace } from '../../assistant-server/glob-workspace-tool';

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
  files: readonly string[],
  prefix = 'brainstrike-glob-unit-'
): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  createdRoots.push(root);
  for (const relative of files) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, `// ${relative}\n`, 'utf8');
  }
  return root;
}

function singleRoot(rootPath: string): RuntimeData {
  return { workspaceRootPath: rootPath } as RuntimeData;
}

function paths(result: { matches: ReadonlyArray<{ path: string }> }): string[] {
  return result.matches.map((match) => match.path).sort();
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  }
});

describe('runGlobWorkspace — pattern matching', () => {
  it('matches **/*.ts at any depth, excluding non-ts files', async () => {
    const root = await makeWorkspace([
      'src/main.ts',
      'src/lib/util.ts',
      'src/components/button.tsx',
      'README.md',
    ]);
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/lib/util.ts', '/src/main.ts']);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('treats a bare pattern (no leading **/) as recursive', async () => {
    const root = await makeWorkspace(['a/b/c.test.ts', 'x.test.ts', 'keep.ts']);
    const result = await runGlobWorkspace({ pattern: '*.test.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/a/b/c.test.ts', '/x.test.ts']);
  });

  it('honors a directory-scoped pattern (src/**)', async () => {
    const root = await makeWorkspace(['src/a.ts', 'src/nested/b.ts', 'lib/c.ts']);
    const result = await runGlobWorkspace({ pattern: 'src/**' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/a.ts', '/src/nested/b.ts']);
  });

  it('matches an exact path', async () => {
    const root = await makeWorkspace(['package.json', 'src/package.json']);
    const result = await runGlobWorkspace({ pattern: 'package.json' }, singleRoot(root));
    // Bare pattern is recursive, so both package.json files match.
    expect(paths(result)).toEqual(['/package.json', '/src/package.json']);
  });

  it('returns an empty result (not an error) when nothing matches', async () => {
    const root = await makeWorkspace(['src/main.ts']);
    const result = await runGlobWorkspace({ pattern: '**/*.rs' }, singleRoot(root));
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
  });

  it('matches a root-anchored pattern (/src/**/*.ts) the same as the unrooted form', async () => {
    const root = await makeWorkspace([
      'src/main.ts',
      'src/lib/util.ts',
      'src/components/button.tsx',
      'README.md',
    ]);
    const rooted = await runGlobWorkspace({ pattern: '/src/**/*.ts' }, singleRoot(root));
    const unrooted = await runGlobWorkspace({ pattern: 'src/**/*.ts' }, singleRoot(root));
    expect(paths(rooted)).toEqual(['/src/lib/util.ts', '/src/main.ts']);
    // The rooted form must compile to the SAME matcher as the unrooted form.
    expect(paths(rooted)).toEqual(paths(unrooted));
  });

  it('still matches a root-anchored recursive pattern (/**/*.ts)', async () => {
    const root = await makeWorkspace(['src/main.ts', 'src/lib/util.ts', 'README.md']);
    const result = await runGlobWorkspace({ pattern: '/**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/lib/util.ts', '/src/main.ts']);
  });
});

describe('runGlobWorkspace — ignore handling', () => {
  it('excludes node_modules, .git, and build output by default', async () => {
    const root = await makeWorkspace([
      'src/main.ts',
      'node_modules/dep/index.ts',
      '.git/hooks/pre-commit.ts',
      'dist/bundle.ts',
      'build/out.ts',
    ]);
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/main.ts']);
  });

  it('excludes lockfiles and minified/map artifacts by default', async () => {
    const root = await makeWorkspace([
      'src/app.ts',
      'pnpm-lock.yaml',
      'src/vendor.min.js',
      'src/app.js.map',
    ]);
    const result = await runGlobWorkspace({ pattern: '**/*' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/app.ts']);
  });

  it('includeIgnored: true surfaces node_modules and build output', async () => {
    const root = await makeWorkspace([
      'src/main.ts',
      'node_modules/dep/index.ts',
      'dist/bundle.ts',
    ]);
    const result = await runGlobWorkspace(
      { pattern: '**/*.ts', includeIgnored: true },
      singleRoot(root)
    );
    expect(paths(result)).toEqual([
      '/dist/bundle.ts',
      '/node_modules/dep/index.ts',
      '/src/main.ts',
    ]);
  });

  it('never descends into .git even with includeIgnored', async () => {
    const root = await makeWorkspace(['src/main.ts', '.git/config.ts']);
    const result = await runGlobWorkspace(
      { pattern: '**/*.ts', includeIgnored: true },
      singleRoot(root)
    );
    expect(paths(result)).toEqual(['/src/main.ts']);
  });
});

describe('runGlobWorkspace — multi-root scoping', () => {
  function multiRoot(roots: RuntimeWorkspaceRoot[]): RuntimeData {
    return { workspaceRoots: roots } as RuntimeData;
  }

  it('enumerates across every open root, labelling each match', async () => {
    const rootA = await makeWorkspace(['a.ts'], 'brainstrike-glob-rootA-');
    const rootB = await makeWorkspace(['b.ts'], 'brainstrike-glob-rootB-');
    const result = await runGlobWorkspace(
      { pattern: '**/*.ts' },
      multiRoot([
        { rootId: 'id-a', displayName: 'alpha', path: rootA },
        { rootId: 'id-b', displayName: 'beta', path: rootB },
      ])
    );
    expect(result.matches).toEqual([
      { path: '/a.ts', rootId: 'id-a', rootName: 'alpha' },
      { path: '/b.ts', rootId: 'id-b', rootName: 'beta' },
    ]);
  });

  it('scopes to the named root when root is provided', async () => {
    const rootA = await makeWorkspace(['a.ts'], 'brainstrike-glob-rootA-');
    const rootB = await makeWorkspace(['b.ts'], 'brainstrike-glob-rootB-');
    const result = await runGlobWorkspace(
      { pattern: '**/*.ts', root: 'beta' },
      multiRoot([
        { rootId: 'id-a', displayName: 'alpha', path: rootA },
        { rootId: 'id-b', displayName: 'beta', path: rootB },
      ])
    );
    expect(result.matches).toEqual([{ path: '/b.ts', rootId: 'id-b', rootName: 'beta' }]);
  });

  it('throws an actionable error for an unknown root qualifier', async () => {
    const rootA = await makeWorkspace(['a.ts'], 'brainstrike-glob-rootA-');
    await expect(
      runGlobWorkspace(
        { pattern: '**/*.ts', root: 'nope' },
        multiRoot([{ rootId: 'id-a', displayName: 'alpha', path: rootA }])
      )
    ).rejects.toThrow(/No folder "nope"/);
  });

  it('throws when no folder is open', async () => {
    await expect(runGlobWorkspace({ pattern: '**/*.ts' }, {} as RuntimeData)).rejects.toThrow(
      /No folder is open/
    );
  });
});

describe('runGlobWorkspace — symlink path-escape discipline', () => {
  it('does not follow a symlink whose target lives outside the root', async () => {
    const root = await makeWorkspace(['src/inside.ts']);
    // A sibling dir OUTSIDE the workspace root holds a secret file.
    const outside = await makeWorkspace(['secret.ts'], 'brainstrike-glob-outside-');

    // Symlinked file pointing OUTSIDE the root → must be dropped.
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'escape.ts'));
    // Symlinked DIRECTORY pointing OUTSIDE the root → must never be traversed.
    await fsPromises.symlink(outside, path.join(root, 'linkdir'));

    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/inside.ts']);
    expect(JSON.stringify(result)).not.toContain('secret.ts');
  });

  it('follows an in-root symlink to a regular file inside the root', async () => {
    const root = await makeWorkspace(['src/real.ts']);
    await fsPromises.symlink(path.join(root, 'src', 'real.ts'), path.join(root, 'src', 'alias.ts'));
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/alias.ts', '/src/real.ts']);
  });
});

describe('runGlobWorkspace — token budget + paging', () => {
  it('truncates a large match set with truncated: true and an actionable hint', async () => {
    // Long paths so the serialized result must exceed the output budget.
    const longSegment = 'deeply-nested-directory-segment-for-budget-pressure';
    const files = Array.from(
      { length: 600 },
      (_, index) => `${longSegment}/${longSegment}/file-${String(index).padStart(4, '0')}.ts`
    );
    const root = await makeWorkspace(files);
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));

    expect(result.totalMatches).toBe(600);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeLessThan(600);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/offset:/);
    // The hint's "of N" count MUST report the true total (600), not the
    // limited window size (the default `limit` of 200). Reporting the window
    // size tells the model there are fewer matches than exist → it under-pages.
    expect(result.hint).toMatch(/of 600\b/);
    expect(result.hint).not.toMatch(/of 200\b/);
  });

  it('reports the true total in the hint when limit caps the set below the budget', async () => {
    // 10 small matches, limit 4: the budget fits all 4 surfaced rows, so the
    // ONLY truncation is the user-facing limit. The hint must still say "of 10".
    const files = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
    const root = await makeWorkspace(files);
    const result = await runGlobWorkspace({ pattern: '**/*.ts', limit: 4 }, singleRoot(root));
    expect(result.matches.length).toBe(4);
    expect(result.totalMatches).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/of 10\b/);
    // Never the window size (4) the limit produced.
    expect(result.hint).not.toMatch(/of 4\b/);
  });

  it('respects an explicit limit and pages via offset', async () => {
    const files = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
    const root = await makeWorkspace(files);

    const firstPage = await runGlobWorkspace({ pattern: '**/*.ts', limit: 4 }, singleRoot(root));
    expect(firstPage.matches.length).toBe(4);
    expect(firstPage.totalMatches).toBe(10);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.offset).toBe(0);

    const secondPage = await runGlobWorkspace(
      { pattern: '**/*.ts', limit: 4, offset: 4 },
      singleRoot(root)
    );
    expect(secondPage.matches.length).toBe(4);
    expect(secondPage.offset).toBe(4);
    // No overlap between pages.
    const firstPaths = new Set(firstPage.matches.map((match) => match.path));
    for (const match of secondPage.matches) {
      expect(firstPaths.has(match.path)).toBe(false);
    }
  });
});
