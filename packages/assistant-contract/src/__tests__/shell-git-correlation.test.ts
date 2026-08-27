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

  it.each(['gh pr create --fill', 'gh  pr   create -t x', 'cd /repo && gh pr create --draft'])(
    'flags %s as creating a pull request',
    (command) => {
      expect(scanShellCommandForGitSignals(command).createdPullRequest).toBe(true);
    }
  );

  it.each(['gh pr view', 'gh pr list', 'gh issue create'])('does not flag %s', (command) => {
    expect(scanShellCommandForGitSignals(command).createdPullRequest).toBe(false);
  });

  it('flags both signals independently in one command', () => {
    expect(scanShellCommandForGitSignals('git worktree add ../wt && gh pr create --fill')).toEqual({
      createdPullRequest: true,
      touchedWorktrees: true,
    });
  });

  it('is bounded: only the first 16 KiB of a command is scanned', () => {
    const padded = `${'x'.repeat(20_000)} git worktree add ../wt`;
    expect(scanShellCommandForGitSignals(padded).touchedWorktrees).toBe(false);
  });

  it('returns both false for an empty command instead of throwing', () => {
    expect(scanShellCommandForGitSignals('')).toEqual({
      createdPullRequest: false,
      touchedWorktrees: false,
    });
  });
});
