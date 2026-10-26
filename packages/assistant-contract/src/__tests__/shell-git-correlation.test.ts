import { describe, expect, it } from 'vitest';
import { scanShellCommandForGitSignals } from '../shell-git-correlation';

describe('scanShellCommandForGitSignals', () => {
  it.each([
    'git worktree add ../wt -b feature',
    'git worktree remove ../wt',
    'cd /repo && git worktree add "$DIR"',
    'git   worktree\tadd ../wt',
    'git -C /repo worktree add ../wt',
    'pnpm build; git worktree prune',
  ])('flags %s as touching worktrees', (command) => {
    expect(scanShellCommandForGitSignals(command).touchedWorktrees).toBe(true);
  });

  it.each([
    'git status',
    'git worktree list',
    'git log --oneline worktree',
    '# git worktree add ../wt',
    'echo "git worktree add" >> notes.md',
    'rg "worktree add" src',
  ])('does not flag %s', (command) => {
    expect(scanShellCommandForGitSignals(command).touchedWorktrees).toBe(false);
  });

  it('is bounded: only the first 16 KiB of a command is scanned', () => {
    const padded = `${'x'.repeat(20_000)} git worktree add ../wt`;
    expect(scanShellCommandForGitSignals(padded).touchedWorktrees).toBe(false);
  });

  it('returns false for an empty command instead of throwing', () => {
    expect(scanShellCommandForGitSignals('')).toEqual({ touchedWorktrees: false });
  });
});
