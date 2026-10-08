import type { Migration } from './migration-runner.js';

/**
 * BST-1934, the one-time legacy upgrade: every decision the legacy Mastra
 * runtime left waiting on the user becomes interrupted, so nothing it parked can
 * authorize or resume a run once the committed host owns new work. One forward
 * transaction, and every statement is a no-op on a second pass.
 *
 * - An unanswered `tool.approval.requested` pause gets the run-event kind that
 *   already means "this pause cannot be answered" (`tool.resume.unsupported`),
 *   which also clears its "needs you" projection. The answer predicate is the
 *   one `use-threads-awaiting-approval.ts` uses.
 * - Suspended or otherwise unfinished Mastra workflow snapshots (approvals,
 *   questions, plans) become `canceled`, which Mastra never resumes. The table
 *   is created lazily by the Mastra store, so it may not exist yet.
 * - Parked background tasks and delegated continuation receipts and decisions
 *   become cancelled or interrupted. Completed-but-undelivered background
 *   results are left exactly as they are.
 */
export const migration145LegacyUpgradeInterruptPending: Migration = {
  // Deliberately a no-op (test rollback chains only; production has no down path):
  // reopening an interrupted pause would re-arm an authorization this revoked.
  down: 'SELECT 1;',
  ledgerKey: 'custom-145-legacy-upgrade-interrupt-pending',
  name: 'legacy_upgrade_interrupt_pending',
  up: `
INSERT INTO brainstrike_assistant_run_events
  (id, run_id, resource_id, thread_id, sequence, kind, status, label, metadata, occurred_at, created_at, updated_at)
SELECT
  'legacy-upgrade:' || requested.id,
  requested.run_id,
  requested.resource_id,
  requested.thread_id,
  (SELECT COALESCE(MAX(existing.sequence), 0) FROM brainstrike_assistant_run_events existing
    WHERE existing.run_id = requested.run_id)
    + ROW_NUMBER() OVER (PARTITION BY requested.run_id ORDER BY requested.sequence, requested.id),
  'tool.resume.unsupported',
  'failed',
  'Interrupted by the upgrade: this pause can no longer be answered',
  jsonb_build_object(
    'interruptedByLegacyUpgrade', true,
    'runId', requested.run_id,
    'toolCallId', requested.metadata->>'toolCallId',
    'toolName', requested.metadata->>'toolName'
  ),
  NOW(),
  NOW(),
  NOW()
FROM brainstrike_assistant_run_events requested
WHERE requested.kind = 'tool.approval.requested'
  AND requested.metadata->>'toolCallId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM brainstrike_assistant_run_events answer
    WHERE answer.resource_id = requested.resource_id
      AND answer.thread_id = requested.thread_id
      AND answer.metadata->>'toolCallId' = requested.metadata->>'toolCallId'
      AND answer.kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported')
      AND answer.occurred_at > requested.occurred_at
  )
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('mastra_workflow_snapshot') IS NOT NULL THEN
    UPDATE mastra_workflow_snapshot
    SET snapshot = jsonb_set(snapshot, '{status}', '"canceled"'), "updatedAt" = NOW()
    WHERE snapshot->>'status' IN ('running', 'suspended', 'waiting', 'pending', 'paused');
  END IF;
END $$;

UPDATE mastra_background_tasks
SET status = 'cancelled'
WHERE status IN ('pending', 'running', 'suspended');

UPDATE brainstrike_delegated_continuations
SET state = 'interrupted', error = 'Interrupted by the upgrade', updated_at = NOW()
WHERE state IN ('claimed', 'running', 'awaiting-approval', 'awaiting-input');

UPDATE brainstrike_delegated_continuation_decisions
SET state = 'interrupted'
WHERE state = 'claimed';

UPDATE brainstrike_delegated_tool_decisions
SET state = 'interrupted'
WHERE state = 'claimed';
`,
  version: 145,
};
