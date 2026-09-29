import type { Migration } from './migration-runner.js';

/** Revokes invocation admission; native snapshots still own execution state. */
export const migration134DelegatedCancellationAdmission: Migration = {
  down: 'ALTER TABLE brainstrike_delegated_invocations DROP COLUMN IF EXISTS cancellation_requested_at;',
  ledgerKey: 'custom-134-delegated-cancellation-admission',
  name: 'delegated_cancellation_admission',
  up: 'ALTER TABLE brainstrike_delegated_invocations ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz;',
  version: 134,
};
