// @vitest-environment node
/**
 * The visible-file token-indexing trigger honours the SHARED background-indexing
 * path exclusions.
 *
 * BST-1207 widened token indexing from selection-only to visible + expanded
 * directories. That new trigger walked the whole display tree without ever
 * consulting the entry policy, so it dispatched `.claude/worktrees` — throwaway
 * whole-repo copies that Claude Code creates and that the indexer deliberately
 * refuses. With ~28 worktrees on disk, one directory expansion queued 28
 * duplicate corpus scans, each costing a full-content IPC read per file.
 *
 * The exclusion prunes at the DIRECTORY, so nothing beneath it is ever minted
 * into a key. What it must NOT do is over-reach: the rest of `.claude` (skills,
 * commands, settings, memory) stays indexable, and no size/extension gate from
 * the policy leaks in — the Explorer must keep counting tokens for every row it
 * actually shows.
 */

import { createDirectoryNode, createFileNode } from '@brainstrike/file-tree-test-fixtures';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { buildFileHandleMap } from '../indexing/background-token-indexer-handles';
import { collectVisibleFileSelectionKeys } from '../indexing/visible-file-selection-keys';

const ROOT_ID = 'aaaaaaaa-0000-4000-8000-0000000000aa';

function file(name: string, path: string): IFileNode {
  return createFileNode({ name, path, rootFolderId: ROOT_ID });
}

function dir(name: string, path: string, children: IFileNode[]): IFileNode {
  return createDirectoryNode({ children, name, path, rootFolderId: ROOT_ID });
}

/** Root-relative paths of the keys, for readable assertions. */
function relativePaths(keys: Set<string>): string[] {
  return [...keys].map((key) => key.split('|@|')[1] ?? key).sort();
}

describe('collectVisibleFileSelectionKeys path exclusions', () => {
  it('uses the same composite-key format as the production handle map', () => {
    const tree = [file('index.ts', '/repo/index.ts')];
    const visibleKeys = collectVisibleFileSelectionKeys(tree);
    const handleMap = new Map();

    buildFileHandleMap(tree, handleMap);

    expect(visibleKeys.size).toBe(1);
    expect([...visibleKeys]).toEqual([...handleMap.keys()]);
  });

  it('never mints a key for anything under .claude/worktrees', () => {
    const tree = [
      dir('.claude', '/repo/.claude', [
        dir('worktrees', '/repo/.claude/worktrees', [
          dir('agent-a834f8', '/repo/.claude/worktrees/agent-a834f8', [
            dir('packages', '/repo/.claude/worktrees/agent-a834f8/packages', [
              file(
                'threads-panel-dnd.ts',
                '/repo/.claude/worktrees/agent-a834f8/packages/threads-panel-dnd.ts'
              ),
            ]),
          ]),
        ]),
      ]),
      file('index.ts', '/repo/index.ts'),
    ];

    expect(relativePaths(collectVisibleFileSelectionKeys(tree))).toEqual(['/repo/index.ts']);
  });

  it('keeps the rest of .claude indexable', () => {
    // The exclusion is the two-segment path, NOT the `.claude` segment: skills
    // and commands are hand-written content the token column should show.
    const tree = [
      dir('.claude', '/repo/.claude', [
        dir('skills', '/repo/.claude/skills', [file('build.md', '/repo/.claude/skills/build.md')]),
        dir('worktrees', '/repo/.claude/worktrees', [
          file('copy.ts', '/repo/.claude/worktrees/copy.ts'),
        ]),
      ]),
    ];

    expect(relativePaths(collectVisibleFileSelectionKeys(tree))).toEqual([
      '/repo/.claude/skills/build.md',
    ]);
  });

  it('matches only at the root, so a nested .claude/worktrees is untouched', () => {
    // Pins the policy's ROOT-ANCHORED contract. A vendored fixture that merely
    // contains those segments deeper down is ordinary content, and silently
    // dropping it would be a second, invisible exclusion rule.
    const tree = [
      dir('fixtures', '/repo/fixtures', [
        dir('.claude', '/repo/fixtures/.claude', [
          dir('worktrees', '/repo/fixtures/.claude/worktrees', [
            file('sample.ts', '/repo/fixtures/.claude/worktrees/sample.ts'),
          ]),
        ]),
      ]),
    ];

    expect(relativePaths(collectVisibleFileSelectionKeys(tree))).toEqual([
      '/repo/fixtures/.claude/worktrees/sample.ts',
    ]);
  });

  it('applies no size or extension gate of its own', () => {
    // Only the PATH rule is borrowed from the policy. Its file gate would drop
    // a `.lock` or an oversized file, blanking the Tokens cell for a row the
    // user is looking at.
    const tree = [
      file('pnpm-lock.yaml', '/repo/pnpm-lock.yaml'),
      file('notes.md', '/repo/notes.md'),
    ];

    expect(relativePaths(collectVisibleFileSelectionKeys(tree))).toEqual([
      '/repo/notes.md',
      '/repo/pnpm-lock.yaml',
    ]);
  });
});
