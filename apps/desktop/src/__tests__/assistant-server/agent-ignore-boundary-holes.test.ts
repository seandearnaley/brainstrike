/**
 * The three ways the hard boundary was still reachable after #2599 (BST-1435).
 *
 * Each is a way a user's `.llmignore` failed to mean what it says, and none of
 * them were caught by the suite that shipped — because the suite only tested
 * the happy path (a readable file, present at start, inside the opened root).
 * A boundary has to be tested by how it FAILS.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentIgnoreGuard } from '../../assistant-server/agent-ignore-guard';
import { runGlobWorkspace } from '../../assistant-server/glob-workspace-tool';
import { singleRootRuntime } from './_tool-test-helpers';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>, prefix = 'bs-holes-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  createdRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, contents, 'utf8');
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
      await fsPromises.chmod(root, 0o755).catch(() => undefined);
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('HOLE 1 — an unreadable .llmignore must STOP the walk, not widen it', () => {
  it('refuses the glob rather than listing files the unreadable rules covered', async () => {
    // The walk's reader warned and carried on. For the BYPASSABLE layers that
    // is right: the cost is a wider walk. For the agent layers the cost is the
    // protected file being listed, indexed, and sent — the whole failure the
    // file exists to prevent, reached by a permissions error.
    const root = await makeWorkspace({
      '.llmignore': 'secrets/\n',
      'docs/real.md': '',
      'secrets/key.md': '',
    });
    await fsPromises.chmod(path.join(root, '.llmignore'), 0o000);
    try {
      await expect(runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root))).rejects.toThrow(
        /agent ignore file/i
      );
    } finally {
      await fsPromises.chmod(path.join(root, '.llmignore'), 0o644);
    }
  });

  it('still tolerates an unreadable .gitignore, which only costs a wider walk', async () => {
    // The asymmetry is the point, so it is pinned rather than left implied.
    const root = await makeWorkspace({ '.gitignore': 'vendor-cache/\n', 'docs/real.md': '' });
    await fsPromises.chmod(path.join(root, '.gitignore'), 0o000);
    try {
      const result = await runGlobWorkspace({ pattern: '**/*.md' }, singleRoot(root));
      expect(paths(result)).toEqual(['/docs/real.md']);
    } finally {
      await fsPromises.chmod(path.join(root, '.gitignore'), 0o644);
    }
  });
});

describe('HOLE 2 — a .llmignore added AFTER the first query must take effect', () => {
  it('sees a rule written after the guard has already answered once', async () => {
    // The exact sequence a user performs: notice the agent read something,
    // add it to `.llmignore`, ask again. A process-wide cache with no
    // invalidation answered from the pre-edit state until restart. "It cannot
    // loosen on its own" was the wrong safety property — tightening is what
    // the user is doing, and that is what went missing.
    const root = await makeWorkspace({ 'secrets/key.ts': '' });
    const before = createAgentIgnoreGuard(root);
    expect(await before.ignoresFile('secrets/key.ts')).toBe(false);

    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');

    const after = createAgentIgnoreGuard(root);
    expect(await after.ignoresFile('secrets/key.ts')).toBe(true);
  });

  it('sees the rule through the shared entry point the read tools use', async () => {
    const root = await makeWorkspace({ 'secrets/key.ts': '' });
    const { assertNotAgentIgnored } = await import('../../assistant-server/agent-ignore-guard');
    await expect(
      assertNotAgentIgnored({ canonicalRootPath: root, relativePath: 'secrets/key.ts' })
    ).resolves.toBeUndefined();

    await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');

    await expect(
      assertNotAgentIgnored({ canonicalRootPath: root, relativePath: 'secrets/key.ts' })
    ).rejects.toThrow(/agent ignore file/i);
  });
});

describe('HOLE 3 — a .llmignore ABOVE the opened root must still bind', () => {
  it('honours a repo-root .llmignore when a subdirectory is opened as the root', async () => {
    // Parent scopes read `.gitignore` and nothing else, so the agent layers
    // silently stopped at the opened root. Opening `packages/web` in a repo
    // whose root `.llmignore` protects `packages/web/secrets/` gave no
    // protection at all — and the user has no way to see that.
    const repo = await makeWorkspace({
      '.llmignore': 'workspace/secrets/\n',
      'workspace/secrets/key.md': '',
      'workspace/src/real.md': '',
    });
    await fsPromises.mkdir(path.join(repo, '.git'), { recursive: true });

    const result = await runGlobWorkspace(
      { pattern: '**/*.md' },
      singleRoot(path.join(repo, 'workspace'))
    );

    expect(paths(result)).toEqual(['/src/real.md']);
  });

  it('honours a parent .llmignore on the direct-read guard too', async () => {
    // The walk and the guard must agree, or the boundary depends on which
    // tool the model happened to reach for.
    const repo = await makeWorkspace({
      '.llmignore': 'workspace/secrets/\n',
      'workspace/secrets/key.md': '',
    });
    await fsPromises.mkdir(path.join(repo, '.git'), { recursive: true });

    const guard = createAgentIgnoreGuard(path.join(repo, 'workspace'));
    expect(await guard.ignoresFile('secrets/key.md')).toBe(true);
  });
});
