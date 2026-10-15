import { CURRENT_SCHEMA_DDL, CURRENT_SCHEMA_LEDGER_KEY } from './current-schema-ddl.js';
import type { Migration } from './migration-runner.js';

/**
 * Migration 001: construct the current schema in one step.
 *
 * This is the whole registry. Brainstrike is greenfield (ADR-0020), so there is
 * no database anywhere whose history needs replaying -- the 151-step
 * incremental chain this replaced existed only to arrive at the schema
 * {@link CURRENT_SCHEMA_DDL} now states outright, read back from the catalogs of
 * a database that chain built.
 *
 * No `down`. ADR-0020 does not build migration rollback: a greenfield profile is
 * reset, not reversed, and `MigrationRunner.rollback` refuses a migration
 * without one rather than pretending to undo a schema construction.
 *
 * {@link CURRENT_SCHEMA_LEDGER_KEY} is the sha256 of the DDL, so a schema change
 * changes the ledger identity and `assertNoStaleDrizzleMigrationLedger` makes an
 * already-built profile fail to open instead of silently staying on a schema
 * this build no longer ships.
 */
export const migration001CurrentSchema: Migration = {
  ledgerKey: CURRENT_SCHEMA_LEDGER_KEY,
  name: 'current_schema',
  up: CURRENT_SCHEMA_DDL,
  version: 1,
};
