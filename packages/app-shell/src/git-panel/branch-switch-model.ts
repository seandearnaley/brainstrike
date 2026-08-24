/** Shared row and eligibility model for the Git workbench and BranchChip. */
import type { GitBranchSummary, GitStatus } from '@brainstrike/types';

export interface BranchSwitchRow {
  readonly current: boolean;
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  readonly worktreeName: string | null;
}

export interface BranchSwitchModel {
  readonly dirty: boolean;
  readonly rows: readonly BranchSwitchRow[];
  readonly scopeReason: string | null;
}

const SUBFOLDER_SCOPE_REASON =
  'This folder is below the repository root — open the repository root to switch branches.';
export const DIRTY_REASON =
  'Working tree has uncommitted changes. Switching in a new worktree is unavailable until Worktree support lands.';
const CURRENT_REASON = 'Already checked out here.';

/** Untracked-only trees remain eligible; tracked porcelain entries do not. */
export function deriveBranchSwitchDirty(status: Pick<GitStatus, 'files'>): boolean {
  return status.files.some((file) => !file.untracked);
}

function worktreeBasename(worktreePath: string): string {
  const normalized = worktreePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function resolveDisabledReason(
  branch: GitBranchSummary,
  worktreeName: string | null,
  dirty: boolean,
  scopeReason: string | null
): string | null {
  if (scopeReason) {
    return scopeReason;
  }
  if (branch.current) {
    return CURRENT_REASON;
  }
  if (worktreeName) {
    return `Checked out in worktree "${worktreeName}" — git allows one checkout per branch.`;
  }
  return dirty ? DIRTY_REASON : null;
}

export function buildBranchSwitchModel(input: {
  readonly branches: readonly GitBranchSummary[];
  readonly dirty: boolean;
  readonly query: string;
  readonly scope: 'repository' | 'workspace';
}): BranchSwitchModel {
  const scopeReason = input.scope === 'workspace' ? SUBFOLDER_SCOPE_REASON : null;
  const needle = input.query.trim().toLowerCase();
  const rows: BranchSwitchRow[] = [];
  for (const branch of input.branches) {
    // Keep the current branch visible as orientation even when it misses the query.
    if (!(branch.current || needle === '' || branch.name.toLowerCase().includes(needle))) {
      continue;
    }
    const worktreeName =
      branch.worktreePath && !branch.current ? worktreeBasename(branch.worktreePath) : null;
    const disabledReason = resolveDisabledReason(branch, worktreeName, input.dirty, scopeReason);
    rows.push({
      current: branch.current,
      disabledReason,
      name: branch.name,
      switchable: disabledReason === null,
      worktreeName,
    });
  }
  return { dirty: input.dirty, rows, scopeReason };
}
