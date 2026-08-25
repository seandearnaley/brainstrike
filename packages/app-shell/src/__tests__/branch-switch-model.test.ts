import type { GitBranchSummary, GitStatusFile } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { buildBranchSwitchModel, deriveBranchSwitchDirty } from '../git-panel/branch-switch-model';

const branch = (name: string, overrides: Partial<GitBranchSummary> = {}): GitBranchSummary => ({
  current: false,
  head: 'a'.repeat(40),
  name,
  upstream: null,
  worktreePath: null,
  ...overrides,
});

const statusFile = (untracked: boolean): GitStatusFile => ({
  path: untracked ? 'new.txt' : 'tracked.txt',
  staged: false,
  status: untracked ? '?' : 'M',
  unstaged: !untracked,
  untracked,
});

const branches = [
  branch('main', { current: true }),
  branch('feature/alpha'),
  branch('feature/beta', { worktreePath: '/wt/beta-copy' }),
];

describe('buildBranchSwitchModel', () => {
  it('preserves recency order, identifies current, and filters without hiding current', () => {
    const all = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'repository' });
    expect(all.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha', 'feature/beta']);
    expect(all.rows[0]).toMatchObject({ current: true, switchable: false });

    const filtered = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: 'ALPHA',
      scope: 'repository',
    });
    expect(filtered.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha']);
  });

  it('disables a branch held by another worktree with a visible named reason', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: '',
      scope: 'repository',
    });
    expect(model.rows.find((row) => row.name === 'feature/beta')).toMatchObject({
      disabledReason: 'Checked out in worktree "beta-copy" — git allows one checkout per branch.',
      switchable: false,
      worktreeName: 'beta-copy',
    });
  });

  it('applies visible dirty and subfolder gates', () => {
    const dirty = buildBranchSwitchModel({ branches, dirty: true, query: '', scope: 'repository' });
    expect(dirty.rows.find((row) => row.name === 'feature/alpha')?.disabledReason).toContain(
      'new worktree is unavailable'
    );

    const subfolder = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: '',
      scope: 'workspace',
    });
    expect(subfolder.scopeReason).toContain('open the repository root');
    expect(subfolder.rows.every((row) => !row.switchable)).toBe(true);
  });
});

describe('deriveBranchSwitchDirty', () => {
  it('allows clean and untracked-only trees', () => {
    expect(deriveBranchSwitchDirty({ files: [] })).toBe(false);
    expect(deriveBranchSwitchDirty({ files: [statusFile(true)] })).toBe(false);
  });

  it('refuses any tracked change, including when mixed with untracked files', () => {
    expect(deriveBranchSwitchDirty({ files: [statusFile(false)] })).toBe(true);
    expect(deriveBranchSwitchDirty({ files: [statusFile(true), statusFile(false)] })).toBe(true);
  });
});
