// @vitest-environment node
import path from 'node:path';
import { expect, test } from 'vitest';
import { desktopManagedWorktreeDirectory } from '../agent-host-platform/desktop-worktree-directory';

const homeDirectory = '/Users/tester';

test('desktop E2E uses an absolute managed-directory override', () => {
  expect(
    desktopManagedWorktreeDirectory({
      e2e: true,
      env: { BRAINSTRIKE_E2E_WORKTREE_DIR: '/tmp/brainstrike-e2e-worktrees' },
      homeDirectory,
    })
  ).toBe('/tmp/brainstrike-e2e-worktrees');
});

test('desktop E2E refuses a relative managed-directory override', () => {
  expect(() =>
    desktopManagedWorktreeDirectory({
      e2e: true,
      env: { BRAINSTRIKE_E2E_WORKTREE_DIR: 'relative/worktrees' },
      homeDirectory,
    })
  ).toThrow('BRAINSTRIKE_E2E_WORKTREE_DIR must be an absolute path.');
});

test('a shipped build ignores the managed-directory override', () => {
  expect(
    desktopManagedWorktreeDirectory({
      e2e: false,
      env: { BRAINSTRIKE_E2E_WORKTREE_DIR: '/tmp/brainstrike-e2e-worktrees' },
      homeDirectory,
    })
  ).toBe(path.join(homeDirectory, '.brainstrike', 'worktrees'));
});
