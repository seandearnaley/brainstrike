/**
 * Unit coverage for the desktop `brainstrike.globWorkspace` tool
 * (`runGlobWorkspace`). Exercises the real FS walk + real ignore policy + real
 * path containment against temp-dir workspaces — no DB, no agent loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { runGlobWorkspace } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Restore an env var to its prior value, deleting it when it was unset. */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}

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
  return singleRootRuntime(rootPath);
}

function paths(result: { matches: ReadonlyArray<{ path: string }> }): string[] {
  return result.matches.map((match) => match.path).sort();
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
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

  it('excludes a repo-local pnpm store, which otherwise starves the walk cap', async () => {
    // Field failure 2026-08-22: `.pnpm-store` was excluded by the `full-root`
    // preset but not by `balanced`, which is the one the walk uses. A real store
    // holds ~82k files — 1.6x the 50,000-file walk cap on its own — and sorts
    // ahead of `apps/`, `docs/` and `packages/`, so the walk exhausted its
    // budget inside the store and every glob returned 0 matches for patterns
    // that plainly matched. The Explorer subagent then burned its whole step
    // budget shelling out instead of using its primary discovery tool.
    //
    // Structurally guarded by the preset-coherence test in
    // `@brainstrike/utils`; asserted HERE too so the walk's own behaviour is
    // pinned at the tool boundary the model actually calls.
    const root = await makeWorkspace([
      'docs/architecture.md',
      '.pnpm-store/v10/files/00/deadbeef.md',
      '.pnpm-store/v10/files/01/cafebabe.md',
    ]);
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/docs/architecture.md']);
    expect(result.scanLimited).toBe(false);
  });

  it('prunes a cache directory that only .gitignore names (BST-1427)', async () => {
    // The general fix for the class BST-1428 was one instance of. A denylist can
    // only skip names someone enumerated; every directory that has actually hurt
    // us was ALREADY gitignored. `vendor-cache` here stands for the ones nobody
    // listed — bazel-*, .gradle, .m2, DerivedData, a relocated pnpm store —
    // and the walk must prune it from `.gitignore` alone.
    const root = await makeWorkspace([
      '.gitignore',
      'docs/architecture.md',
      'vendor-cache/a/one.md',
      'vendor-cache/b/two.md',
    ]);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'vendor-cache/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/docs/architecture.md']);
  });

  it('honours a NESTED .gitignore only within its own subtree (BST-1427)', async () => {
    // `artifacts` deliberately is NOT a name the static floor knows, so the only
    // thing that can prune it is the nested `.gitignore` — and only under the
    // package that declares it.
    const root = await makeWorkspace([
      'packages/web/.gitignore',
      'packages/web/artifacts/out.md',
      'packages/api/artifacts/out.md',
    ]);
    await fsPromises.writeFile(path.join(root, 'packages/web/.gitignore'), 'artifacts/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/packages/api/artifacts/out.md']);
  });

  it('includeIgnored: true still surfaces gitignored files (BST-1427)', async () => {
    const root = await makeWorkspace(['.gitignore', 'vendor-cache/one.md']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'vendor-cache/\n', 'utf8');
    const result = await runGlobWorkspace(
      { includeIgnored: true, pattern: '**/*.md' },
      singleRoot(root)
    );
    expect(paths(result)).toContain('/vendor-cache/one.md');
  });

  it('falls back to the static floor for a root with no .gitignore (BST-1427)', async () => {
    // A folder that is not a git repo has nothing to respect, so the static
    // policy carries it alone. This is why the denylist stays: it is the floor,
    // not the primary signal.
    const root = await makeWorkspace([
      'src/main.ts',
      'node_modules/dep/index.ts',
      '.pnpm-store/v10/cached.ts',
    ]);
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/main.ts']);
  });

  it('drops a gitignored FILE inside a KEPT directory (BST-1427)', async () => {
    // The directory gate and the file gate are separate branches. Every other
    // case here exercises directory patterns, so the file gate in `recordFile`
    // could be deleted with the suite still green — verified by deleting it.
    // It carries the common real case: a generated file or a `.env.local`
    // sitting beside sources in a directory the walk rightly keeps.
    const root = await makeWorkspace(['.gitignore', 'src/main.ts', 'src/api-client.generated.ts']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), '*.generated.ts\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(paths(result)).toEqual(['/src/main.ts']);
  });

  it('steers the model to includeIgnored when a glob matches ONLY excluded files', async () => {
    // The failure this whole PR argues against, in its newest form. Widening the
    // exclusion set from a fixed denylist to "whatever the repo gitignores"
    // means `coverage/**` now returns a bare `{count: 0}` that is
    // indistinguishable from "those files do not exist". A zero with no signal
    // is the silent failure; the hint is what makes it honest.
    const root = await makeWorkspace(['.gitignore', 'coverage/report.html', 'src/main.ts']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'coverage/\n', 'utf8');

    const result = await runGlobWorkspace({ pattern: 'coverage/**' }, singleRoot(root));

    expect(result.count).toBe(0);
    expect(result.hint).toMatch(/includeIgnored/);
  });

  it('does NOT steer to includeIgnored when the glob genuinely matched', async () => {
    // A hint on every successful call is noise the model learns to ignore,
    // which costs us the one case that needed it.
    const root = await makeWorkspace(['src/main.ts']);
    const result = await runGlobWorkspace({ pattern: '**/*.ts' }, singleRoot(root));
    expect(result.count).toBe(1);
    expect(result.hint ?? '').not.toMatch(/includeIgnored/);
  });

  it('does NOT steer to includeIgnored when it is ALREADY set', async () => {
    const root = await makeWorkspace(['.gitignore', 'src/main.ts']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'coverage/\n', 'utf8');
    const result = await runGlobWorkspace(
      { includeIgnored: true, pattern: 'nothing-matches-this/**' },
      singleRoot(root)
    );
    expect(result.count).toBe(0);
    expect(result.hint ?? '').not.toMatch(/includeIgnored/);
  });

  it('does NOT steer to includeIgnored for an agent-ignored path (BST-1432)', async () => {
    // Two reasons, either sufficient. The advice would be a DEAD END — the hard
    // layers are the one exclusion includeIgnored cannot bypass, so the retry
    // returns nothing and burns a turn. And it would LEAK: telling the model
    // "something excluded matches secrets/**" discloses that something exists
    // at a path the user asked to be invisible, which is most of what they were
    // buying. Contrast the .gitignore case above, where the steer is correct.
    const root = await makeWorkspace(['.llmignore', 'secrets/creds.ts']);
    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');

    const result = await runGlobWorkspace({ pattern: 'secrets/**' }, singleRoot(root));

    expect(result.count).toBe(0);
    expect(result.hint ?? '').not.toMatch(/includeIgnored/);
  });

  it('does not surface an in-root SYMLINK to an agent-ignored target (BST-1432)', async () => {
    // Same aliasing hole as the read tools: the walk records the LINK's path
    // while handing the reader the canonical TARGET, so a glob listing the
    // alias makes the excluded file reachable by every consumer downstream.
    const root = await makeWorkspace(['.llmignore', 'secrets/key.md', 'docs/real.md']);
    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');
    await fsPromises.symlink(
      path.join(root, 'secrets', 'key.md'),
      path.join(root, 'docs', 'alias.md')
    );

    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));

    expect(paths(result)).toEqual(['/docs/real.md']);
  });

  it('lets root .gitignore re-include what .git/info/exclude excluded (BST-1431)', async () => {
    // Review of #2599. The root chain (global excludes, info/exclude, parent
    // gitignores) was pushed as a SEPARATE scope at '', so it and the root's
    // own files were two `Ignore` instances at the same directory — folded by
    // hand, which is precisely the thing the matcher's module note forbids. Per
    // the precedence table layer 4 overrides layer 2, and `git check-ignore`
    // agrees; the fold silently dropped the file. Both now compile into ONE
    // scope so the parser resolves them.
    const root = await makeWorkspace(['.gitignore', 'cache/one.md']);
    await fsPromises.mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await fsPromises.writeFile(path.join(root, '.git', 'info', 'exclude'), 'cache/\n', 'utf8');
    await fsPromises.writeFile(path.join(root, '.gitignore'), '!cache/\n', 'utf8');

    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));

    expect(paths(result)).toEqual(['/cache/one.md']);
  });

  it('applies a SLASH-CONTAINING parent .gitignore pattern (BST-1431)', async () => {
    // Review of #2599 (Codex P2). Parent patterns were concatenated into the
    // root scope and evaluated against paths relative to the OPENED root, so
    // `workspace/vendor-blobs/` in `/repo/.gitignore` was tested against
    // `vendor-blobs/x.md` and matched nothing. Git ignores that file; we listed
    // it. Parent scopes now carry the opened root's repo-relative prefix.
    // `vendor-blobs` deliberately is NOT a name the static floor knows, so the
    // parent pattern is the only thing that can exclude it.
    const repo = await makeWorkspace([
      '.gitignore',
      'workspace/vendor-blobs/x.md',
      'workspace/src/real.md',
    ]);
    await fsPromises.mkdir(path.join(repo, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(repo, '.gitignore'), 'workspace/vendor-blobs/\n', 'utf8');

    const result = await runGlobWorkspace(
      { pattern: '**/*.md' },
      singleRoot(path.join(repo, 'workspace'))
    );

    expect(paths(result)).toEqual(['/src/real.md']);
  });

  it('lets the opened root re-include a directory excluded by a parent .gitignore (BST-1434)', async () => {
    const repo = await makeWorkspace([
      '.gitignore',
      'workspace/.gitignore',
      'workspace/cache/one.md',
    ]);
    await fsPromises.mkdir(path.join(repo, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(repo, '.gitignore'), 'workspace/cache/\n', 'utf8');
    await fsPromises.writeFile(path.join(repo, 'workspace', '.gitignore'), '!cache/\n', 'utf8');

    const result = await runGlobWorkspace(
      { pattern: '**/*.md' },
      singleRoot(path.join(repo, 'workspace'))
    );

    expect(paths(result)).toEqual(['/cache/one.md']);
  });

  it('honours .ignore — hide from search, keep in git (BST-1431)', async () => {
    const root = await makeWorkspace(['.ignore', 'fixtures/big.md', 'docs/real.md']);
    await fsPromises.writeFile(path.join(root, '.ignore'), 'fixtures/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/docs/real.md']);
  });

  it('lets .ignore re-include what .gitignore excluded (BST-1431)', async () => {
    // Precedence, not just presence: `.ignore` sits ABOVE `.gitignore`.
    const root = await makeWorkspace(['.gitignore', '.ignore', 'cache/one.md']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'cache/\n', 'utf8');
    await fsPromises.writeFile(path.join(root, '.ignore'), '!cache/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/cache/one.md']);
  });

  it('honours .git/info/exclude for repo-local, uncommitted rules (BST-1431)', async () => {
    const root = await makeWorkspace(['scratch/notes.md', 'docs/real.md']);
    await fsPromises.mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await fsPromises.writeFile(path.join(root, '.git', 'info', 'exclude'), 'scratch/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/docs/real.md']);
  });

  it('honours the machine-wide core.excludesFile (BST-1431)', async () => {
    // Hermetic via git's OWN env seams: GIT_CONFIG_GLOBAL/SYSTEM point git at
    // empty files so the developer's real global config cannot decide whether
    // this test passes, and GIT_CONFIG_GLOBAL is then the file we control.
    const root = await makeWorkspace(['notes.md', 'docs/real.md']);
    const home = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-git-home-'));
    createdRoots.push(home);
    const excludesPath = path.join(home, 'my-excludes');
    await fsPromises.writeFile(excludesPath, 'notes.md\n', 'utf8');
    const configPath = path.join(home, 'gitconfig');
    await fsPromises.writeFile(configPath, `[core]\n\texcludesFile = ${excludesPath}\n`, 'utf8');

    const previousGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const previousSystem = process.env['GIT_CONFIG_SYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = configPath;
    process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
    try {
      const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
      expect(paths(result)).toEqual(['/docs/real.md']);
    } finally {
      restoreEnv('GIT_CONFIG_GLOBAL', previousGlobal);
      restoreEnv('GIT_CONFIG_SYSTEM', previousSystem);
    }
  });

  it('honours a PARENT .gitignore when the root is inside a larger repo (BST-1431)', async () => {
    // ripgrep reads parent gitignores by default (--no-ignore-parent turns it
    // off). Without this, opening `packages/api` as a root silently ignores the
    // repo-root rules that every other tool in the tree obeys.
    const repo = await makeWorkspace([
      '.gitignore',
      'packages/api/scratch/tmp.md',
      'packages/api/src/real.md',
    ]);
    await fsPromises.mkdir(path.join(repo, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(repo, '.gitignore'), 'scratch/\n', 'utf8');

    const result = await runGlobWorkspace(
      { pattern: '**/*.md' },
      singleRoot(path.join(repo, 'packages', 'api'))
    );
    expect(paths(result)).toEqual(['/src/real.md']);
  });

  it('honours .llmignore and .brainstrikeignore (BST-1432)', async () => {
    const root = await makeWorkspace([
      '.llmignore',
      '.brainstrikeignore',
      'secrets/key.md',
      'private/x.md',
      'docs/real.md',
    ]);
    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');
    await fsPromises.writeFile(path.join(root, '.brainstrikeignore'), 'private/\n', 'utf8');
    const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
    expect(paths(result)).toEqual(['/docs/real.md']);
  });

  it('does NOT let includeIgnored bypass the agent ignore file (BST-1432)', async () => {
    // The decision that makes this a security control rather than a preference.
    // Every other exclusion is bypassable here; this one is not, because users
    // put credentials behind it and a single flag must not defeat that.
    const root = await makeWorkspace(['.gitignore', '.llmignore', 'build/x.md', 'secrets/key.md']);
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'build/\n', 'utf8');
    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');
    const result = await runGlobWorkspace(
      { includeIgnored: true, pattern: '**/*.md' },
      singleRoot(root)
    );
    expect(paths(result)).toContain('/build/x.md');
    expect(paths(result)).not.toContain('/secrets/key.md');
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
      { includeIgnored: true, pattern: '**/*.ts' },
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
      { includeIgnored: true, pattern: '**/*.ts' },
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
        { displayName: 'alpha', path: rootA, rootId: 'id-a' },
        { displayName: 'beta', path: rootB, rootId: 'id-b' },
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
        { displayName: 'alpha', path: rootA, rootId: 'id-a' },
        { displayName: 'beta', path: rootB, rootId: 'id-b' },
      ])
    );
    expect(result.matches).toEqual([{ path: '/b.ts', rootId: 'id-b', rootName: 'beta' }]);
  });

  it('scopes an omitted root to the durable thread binding', async () => {
    const rootA = await makeWorkspace(['a.ts'], 'brainstrike-glob-rootA-');
    const rootB = await makeWorkspace(['b.ts'], 'brainstrike-glob-rootB-');
    const result = await runGlobWorkspace(
      { pattern: '**/*.ts' },
      {
        ...multiRoot([
          { displayName: 'alpha', path: rootA, rootId: 'id-a' },
          { displayName: 'beta', path: rootB, rootId: 'id-b' },
        ]),
        boundWorkspaceRootId: 'id-b',
      }
    );

    expect(result.matches).toEqual([{ path: '/b.ts', rootId: 'id-b', rootName: 'beta' }]);
  });

  it('throws an actionable error for an unknown root qualifier', async () => {
    const rootA = await makeWorkspace(['a.ts'], 'brainstrike-glob-rootA-');
    await expect(
      runGlobWorkspace(
        { pattern: '**/*.ts', root: 'nope' },
        multiRoot([{ displayName: 'alpha', path: rootA, rootId: 'id-a' }])
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
    const result = await runGlobWorkspace({ limit: 4, pattern: '**/*.ts' }, singleRoot(root));
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

    const firstPage = await runGlobWorkspace({ limit: 4, pattern: '**/*.ts' }, singleRoot(root));
    expect(firstPage.matches.length).toBe(4);
    expect(firstPage.totalMatches).toBe(10);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.offset).toBe(0);

    const secondPage = await runGlobWorkspace(
      { limit: 4, offset: 4, pattern: '**/*.ts' },
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
