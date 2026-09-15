import type { Migration } from './migration-runner.js';
export const migration137ChildExecutionConfiguration: Migration = {
  down: `DO $$ BEGIN IF EXISTS(SELECT 1 FROM brainstrike_delegated_continuations WHERE execution_configuration IS NOT NULL) THEN RAISE EXCEPTION 'Cannot discard admitted child run configurations'; END IF; END $$; ALTER TABLE brainstrike_delegated_continuations DROP COLUMN IF EXISTS execution_configuration;`,
  ledgerKey: 'custom-137-child-execution-configuration',
  name: 'child_execution_configuration',
  up: `ALTER TABLE brainstrike_delegated_continuations ADD COLUMN IF NOT EXISTS execution_configuration jsonb CHECK(execution_configuration IS NULL OR jsonb_typeof(execution_configuration)='object');`,
  version: 137,
};
