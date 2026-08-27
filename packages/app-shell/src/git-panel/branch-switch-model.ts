/**
 * The pure row model behind BOTH branch switchers: the git panel's workbench
 * header dropdown (`git-workbench-header.tsx`) and the composer's Branch chip.
 *
 * Extracted rather than copied. The header's inline version was the reference
 * implementation for the git rule ("one checkout per branch"), and a second
 * copy in the chip would have drifted the moment either grew a case — the
 * dirty gate below is exactly such a case, and it belongs to both.
 *
 * NO SILENT DISABLES: every non-switchable row carries the reason it is not
 * switchable, ordered most-specific-cause first, and the caller renders it.
 */
import type { GitBranchSummary, GitStatus } from '@brainstrike/types';

export interface BranchSwitchRow {
  readonly current: boolean;
  /** Non-null exactly when `switchable` is false — never a silent disable. */
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  /** Basename of the worktree holding this branch, or null when it is free. */
  readonly worktreeName: string | null;
}

export interface BranchSwitchModel {
  readonly dirty: boolean;
  readonly rows: readonly BranchSwitchRow[];
  /** Non-null when NO row can be switched for a whole-repository reason. */
  readonly scopeReason: string | null;
}

const SUBFOLDER_SCOPE_REASON =
  'This folder is below the repository root — open the repository root to switch branches.';
/** Exported so callers can render the SAME copy as a visible banner (Major 1) — never a paraphrase. */
export const DIRTY_REASON = 'Working tree has uncommitted changes — commit or stash first.';
const CURRENT_REASON = 'Already checked out here.';

/**
 * True only when a TRACKED file is staged or modified. Untracked-only trees
 * are NOT dirty for switch-gating purposes (Major 2 ruling): switching
 * branches neither touches nor is blocked by files git doesn't track, so
 * gating on `!status.clean` gave a false "commit or stash" prompt for a tree
 * that had nothing to commit or stash. The service's porcelain-v2 parser
 * (`git-service.ts`) tags every entry `untracked: false` except plain `?`
 * lines, so this is exactly "any tracked entry exists".
 */
export function deriveBranchSwitchDirty(status: Pick<GitStatus, 'files'>): boolean {
  return status.files.some((file) => !file.untracked);
}

/** Basename of a worktree path, separator-normalized (git prints POSIX or native). */
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
  // Ordered most-specific-cause first: a branch held by another worktree can
  // never be switched to here, dirty or not, so that reason wins.
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
    // The current branch always survives the filter: hiding "where you are"
    // makes the list read as if the checkout moved.
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
