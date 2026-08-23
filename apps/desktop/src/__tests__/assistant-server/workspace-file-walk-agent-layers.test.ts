/**
 * The agent ignore layers must bind on `walkWorkspaceRoot` UNCONDITIONALLY —
 * not behind `respectGitignore` (BST-1432).
 *
 * `recordFile` argues that short-circuiting on `includeIgnored` "would hand the
 * caller a master key over `.llmignore`". Gating the whole matcher behind
 * `respectGitignore` was that same master key one flag up, and a quieter one:
 * the flag is named and documented entirely in terms of `.gitignore`, so the
 * next caller that omits it would inherit a walk with no hard boundary and no
 * signal that it lost one. `walkWorkspaceRoot` is exported, so "the only two
 * callers today are fine" is not a property that stays true.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { walkWorkspaceRoot } from '../../assistant-server/workspace-file-walk';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-walk-layers-'));
  createdRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, contents, 'utf8');
  }
  return root;
}

async function walk(
  rootPath: string,
  options: { includeIgnored?: boolean; respectGitignore?: boolean } = {}
): Promise<string[]> {
  const kept: string[] = [];
  await walkWorkspaceRoot({
    onFile: ({ relativePath }) => kept.push(relativePath),
    ...options,
    root: { displayName: 'w', path: rootPath, rootId: 'r1' },
  });
  return kept.sort();
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('walkWorkspaceRoot — agent ignore layers are unconditional', () => {
  // `vendor-cache` deliberately is NOT a name the static floor knows, so
  // `.gitignore` is the only thing that can exclude it.
  const workspace = {
    '.gitignore': 'vendor-cache/\n',
    '.llmignore': 'secrets/\n',
    'secrets/key.ts': '',
    'src/main.ts': '',
    'vendor-cache/out.ts': '',
  };

  it('honours .llmignore even when respectGitignore is NOT set', async () => {
    const root = await makeWorkspace(workspace);
    const kept = await walk(root);
    expect(kept).not.toContain('secrets/key.ts');
    expect(kept).toContain('src/main.ts');
  });

  it('leaves .gitignore alone when respectGitignore is NOT set', async () => {
    // The bypassable layers stay opt-in — this is the property live grep's
    // rg-vs-walk parity depends on (BST-1429), and it must not change as a
    // side effect of making the agent layers unconditional.
    const root = await makeWorkspace(workspace);
    const kept = await walk(root);
    expect(kept).toContain('vendor-cache/out.ts');
  });

  it('honours .llmignore under respectGitignore AND includeIgnored together', async () => {
    const root = await makeWorkspace(workspace);
    const kept = await walk(root, { includeIgnored: true, respectGitignore: true });
    expect(kept).toContain('vendor-cache/out.ts');
    expect(kept).not.toContain('secrets/key.ts');
  });

  it('honours .llmignore under includeIgnored with respectGitignore unset', async () => {
    // Both master keys at once — the combination a future caller is most
    // likely to reach for, and the one where a gap would be invisible.
    const root = await makeWorkspace(workspace);
    const kept = await walk(root, { includeIgnored: true });
    expect(kept).not.toContain('secrets/key.ts');
  });
});
