import type { Migration } from './migration-runner';

/**
 * Widen roots.kind to accept 'worktree' (BST-1390 Task 10): a root mounted for
 * a BrainStrike-managed git worktree carries this kind, set once at INSERT by
 * `reconcileRoots` and never modified afterward. Must replace migration 039's
 * existing same-name CHECK to widen it (a catalog-guarded ADD-only block would
 * see the old constraint and leave 'worktree' rejected).
 */
export const migration111RootsWorktreeKind: Migration = {
  down: `
    ALTER TABLE roots DROP CONSTRAINT IF EXISTS roots_kind_check;
    ALTER TABLE roots ADD CONSTRAINT roots_kind_check
      CHECK (kind IN ('path', 'fsa', 'snapshot', 'legacy'));
  `,
  ledgerKey: 'custom-111-roots-worktree-kind',
  name: 'roots_worktree_kind',
  up: `
    ALTER TABLE roots DROP CONSTRAINT IF EXISTS roots_kind_check;
    ALTER TABLE roots ADD CONSTRAINT roots_kind_check
      CHECK (kind IN ('path', 'fsa', 'snapshot', 'legacy', 'worktree'));
  `,
  version: 111,
};
