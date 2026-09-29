import type { Migration } from './migration-runner.js';

/** Pending decisions own their child, while only execution owns the root leg. */
export const migration138IndependentChildContinuationPauses: Migration = {
  down: `DROP INDEX IF EXISTS brainstrike_delegated_continuations_active_child_idx;
    DROP INDEX IF EXISTS brainstrike_delegated_continuations_active_root_idx;
    CREATE UNIQUE INDEX brainstrike_delegated_continuations_active_root_idx
      ON brainstrike_delegated_continuations(root_thread_id)
      WHERE state IN ('claimed','running','awaiting-approval','awaiting-input');`,
  ledgerKey: 'custom-138-independent-child-continuation-pauses',
  name: 'independent_child_continuation_pauses',
  up: `DROP INDEX IF EXISTS brainstrike_delegated_continuations_active_root_idx;
    CREATE UNIQUE INDEX brainstrike_delegated_continuations_active_root_idx
      ON brainstrike_delegated_continuations(root_thread_id)
      WHERE state IN ('claimed','running');
    CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_delegated_continuations_active_child_idx
      ON brainstrike_delegated_continuations(root_thread_id,thread_id)
      WHERE state IN ('claimed','running','awaiting-approval','awaiting-input');`,
  version: 138,
};
