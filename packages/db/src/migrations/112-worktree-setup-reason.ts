import type { Migration } from './migration-runner';

/**
 * Adds `setup_reason` to `brainstrike_worktrees` for profiles that already
 * ran migration 109 before this column existed (BST-1390 W3 post-merge fix).
 * Migration 109 was briefly amended in place in PR #2657 to add this column,
 * which is invalid once any profile has executed it — 109 has been reverted
 * to its as-first-shipped shape (#2649) and this additive migration carries
 * the column forward for both fresh and upgraded profiles.
 */
export const migration112WorktreeSetupReason: Migration = {
  down: 'ALTER TABLE brainstrike_worktrees DROP COLUMN IF EXISTS setup_reason;',
  ledgerKey: 'custom-112-worktree-setup-reason',
  name: 'worktree_setup_reason',
  up: 'ALTER TABLE brainstrike_worktrees ADD COLUMN IF NOT EXISTS setup_reason text;',
  version: 112,
};
