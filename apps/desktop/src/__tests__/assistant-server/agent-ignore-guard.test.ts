/**
 * Unit coverage for the path-queryable agent-ignore guard (BST-1432). The
 * push/pop `createWorkspaceIgnoreMatcher` is pinned in `@brainstrike/utils`;
 * what is pinned HERE is the part that differs — resolving an arbitrary
 * relative path's scope chain from disk, and the caller-punctuation and
 * caching behaviour the read paths depend on.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNotAgentIgnored,
  createAgentIgnoreGuard,
} from '../../assistant-server/agent-ignore-guard';

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-agent-ignore-'));
  createdRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, contents, 'utf8');
  }
  return root;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

describe('createAgentIgnoreGuard', () => {
  it('applies a root .llmignore to a nested path', async () => {
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n', 'secrets/a.ts': '' });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('secrets/a.ts')).toBe(true);
    expect(await guard.ignoresFile('src/a.ts')).toBe(false);
  });

  it('applies a NESTED .llmignore, scoped to its own directory', async () => {
    // The scope chain is the whole reason this is not a single root-level
    // matcher: a rule in `packages/api/.llmignore` must bind inside that
    // package and nowhere else.
    const root = await makeWorkspace({
      'packages/api/.llmignore': 'env.ts\n',
      'packages/api/env.ts': '',
      'packages/web/env.ts': '',
    });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('packages/api/env.ts')).toBe(true);
    expect(await guard.ignoresFile('packages/web/env.ts')).toBe(false);
  });

  it('accepts a leading slash, which the read tools produce', async () => {
    // `ignore` refuses an absolute-looking path outright, so without
    // normalisation this surfaces as a confusing `path.relative()` throw from
    // deep inside the parser rather than a verdict.
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n', 'secrets/a.ts': '' });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('/secrets/a.ts')).toBe(true);
  });

  it('lets .brainstrikeignore re-include what .llmignore excluded', async () => {
    // Ours is the higher layer, so it must be able to overturn the portable
    // one — the same last-match-wins ordering the walk uses.
    const root = await makeWorkspace({
      '.brainstrikeignore': '!vendor/\n',
      '.llmignore': 'vendor/\n',
      'vendor/a.ts': '',
    });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('vendor/a.ts')).toBe(false);
  });

  it('matches the walk when an opened-root agent file re-includes a parent exclusion (BST-1434)', async () => {
    const repo = await makeWorkspace({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.llmignore': 'workspace/secrets/\n',
      'workspace/.brainstrikeignore': '!secrets/\n',
      'workspace/secrets/a.ts': '',
    });
    const guard = createAgentIgnoreGuard(path.join(repo, 'workspace'));

    expect(await guard.ignoresFile('secrets/a.ts')).toBe(false);
  });

  it('reports nothing ignored when no agent ignore file exists', async () => {
    const root = await makeWorkspace({ 'src/a.ts': '' });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('src/a.ts')).toBe(false);
  });

  it('does NOT apply .gitignore — it is a hard-layer guard only', async () => {
    // The bypassable layers belong to the walk, which can prune whole trees.
    // Enforcing them here too would silently make `includeIgnored` useless on
    // every read path that consults this guard.
    const root = await makeWorkspace({ '.gitignore': 'dist/\n', 'dist/a.ts': '' });
    const guard = createAgentIgnoreGuard(root);
    expect(await guard.ignoresFile('dist/a.ts')).toBe(false);
  });

  it('resolves each directory once, however many candidates share it', async () => {
    // ripgrep can hand back thousands of paths in one directory; re-reading the
    // ignore files per candidate would turn one grep into thousands of stats.
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n' });
    const guard = createAgentIgnoreGuard(root);
    const verdicts = await Promise.all(
      Array.from({ length: 50 }, (_value, index) => guard.ignoresFile(`src/file-${index}.ts`))
    );
    expect(verdicts.every((verdict) => verdict === false)).toBe(true);
  });
});

describe('createAgentIgnoreGuard — failure modes', () => {
  it('FAILS CLOSED when an agent ignore file exists but cannot be read', async () => {
    // Every other ignore layer may fail open: the worst case is a wider walk.
    // These two are a security boundary, so "I could not read the rules" must
    // never resolve to "there are no rules". An EACCES on `.llmignore` that
    // silently permits the read is the failure mode the boundary exists to
    // prevent, arriving through the door marked "robustness".
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n', 'secrets/a.ts': '' });
    await fsPromises.chmod(path.join(root, '.llmignore'), 0o000);
    try {
      const guard = createAgentIgnoreGuard(root);
      await expect(guard.ignoresFile('secrets/a.ts')).rejects.toThrow(/agent ignore file/i);
    } finally {
      await fsPromises.chmod(path.join(root, '.llmignore'), 0o644);
    }
  });
});

describe('assertNotAgentIgnored', () => {
  it('throws a message naming the ignore files, so the user can find the rule', async () => {
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n', 'secrets/a.ts': '' });
    await expect(
      assertNotAgentIgnored({ canonicalRootPath: root, relativePath: '/secrets/a.ts' })
    ).rejects.toThrow(/\.llmignore/);
  });

  it('resolves for a permitted path', async () => {
    const root = await makeWorkspace({ '.llmignore': 'secrets/\n', 'src/a.ts': '' });
    await expect(
      assertNotAgentIgnored({ canonicalRootPath: root, relativePath: 'src/a.ts' })
    ).resolves.toBeUndefined();
  });
});
