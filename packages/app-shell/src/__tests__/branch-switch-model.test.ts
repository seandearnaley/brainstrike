import type { GitBranchSummary } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { buildBranchSwitchModel } from '../git-panel/branch-switch-model';

function branch(overrides: Partial<GitBranchSummary> & { name: string }): GitBranchSummary {
  return {
    current: false,
    head: 'a'.repeat(40),
    upstream: null,
    worktreePath: null,
    ...overrides,
  };
}

describe('buildBranchSwitchModel', () => {
  const branches = [
    branch({ current: true, name: 'main' }),
    branch({ name: 'feature/alpha' }),
    branch({ name: 'feature/beta', worktreePath: '/wt/beta-copy' }),
  ];

  it('preserves the incoming recency order and marks the current branch', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: '',
      scope: 'repository',
    });
    expect(model.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha', 'feature/beta']);
    expect(model.rows[0]?.current).toBe(true);
  });

  it('disables the current branch with a stated reason', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: '',
      scope: 'repository',
    });
    expect(model.rows[0]?.switchable).toBe(false);
    expect(model.rows[0]?.disabledReason).toBe('Already checked out here.');
  });

  it('disables a branch checked out in another worktree, naming that worktree', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: '',
      scope: 'repository',
    });
    const beta = model.rows.find((row) => row.name === 'feature/beta');
    expect(beta?.switchable).toBe(false);
    expect(beta?.worktreeName).toBe('beta-copy');
    expect(beta?.disabledReason).toBe(
      'Checked out in worktree "beta-copy" — git allows one checkout per branch.'
    );
  });

  it('disables every row while the working tree is dirty, with the dirty reason', () => {
    const model = buildBranchSwitchModel({ branches, dirty: true, query: '', scope: 'repository' });
    const alpha = model.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(false);
    expect(alpha?.disabledReason).toBe(
      'Working tree has uncommitted changes. Switching in a new worktree is unavailable until Worktree support lands.'
    );
  });

  it('prefers the more specific worktree reason over the dirty reason', () => {
    const model = buildBranchSwitchModel({ branches, dirty: true, query: '', scope: 'repository' });
    const beta = model.rows.find((row) => row.name === 'feature/beta');
    expect(beta?.disabledReason).toContain('beta-copy');
  });

  it('filters case-insensitively on a substring but never hides the current branch', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: 'ALPHA',
      scope: 'repository',
    });
    expect(model.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha']);
  });

  it('states the scope reason and disables everything for a subfolder root', () => {
    const model = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'workspace' });
    expect(model.scopeReason).toBe(
      'This folder is below the repository root — open the repository root to switch branches.'
    );
    expect(model.rows.every((row) => row.switchable === false)).toBe(true);
  });
});
