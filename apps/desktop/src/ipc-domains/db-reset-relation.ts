import type { ResetTable } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DatabaseIpc');

/**
 * Derived from the reset-table registry (BST-992): the registry owns the SET
 * every table-enumerating reset path clears; this file owns desktop's order
 * and mechanics. `file_chunks`/`file_records` are excluded because `clearAll`
 * counts and bare-DELETEs them (they are guaranteed by migrations, never
 * legitimately absent), so they never go through the probe helper. A closed
 * literal union on purpose — with `to_regclass` a stale name is a permanent
 * silent skip, so `string` is forbidden here (platform-contracts).
 *
 * `RegisteredBareDeleted` closes the fail-open edge of `Exclude`: if either
 * name ever left the registry, a bare `Exclude` would silently stop removing
 * it, whereas this constrained alias makes it a compile error.
 */
type RegisteredBareDeleted<T extends ResetTable> = T;
type BareDeletedTable = RegisteredBareDeleted<'file_chunks' | 'file_records'>;
type OptionalRelationTable = Exclude<ResetTable, BareDeletedTable>;

/**
 * Deletes every row of a relation that may legitimately be ABSENT, PROBING for
 * it first rather than deleting and catching 42P01.
 *
 * The whole `db:clearAll` body runs inside ONE `db.transaction(...)`, and PGlite
 * is real Postgres: a statement error puts the transaction into the ABORTED
 * state, after which every later command fails with `25P02 current transaction
 * is aborted, commands ignored until end of transaction block` until ROLLBACK.
 * Catching the original 42P01 does NOT undo that, and there are no savepoints
 * anywhere in this repo — so a "tolerated" missing relation rolled the ENTIRE
 * clear back and the user's Clear Database silently did nothing. `to_regclass`
 * returns NULL for an absent relation instead of raising, so the probe can never
 * poison the transaction (BST-558 review).
 *
 * That hazard was live for `mastra_workflow_snapshot` — created lazily by
 * `PgliteWorkflowsStore.initialize()` and by NO migration, so "absent" is the
 * normal state for a never-used assistant. It was latent, not absent, for the
 * migration-created tables: unreachable only for as long as every one of them
 * keeps being created by a numbered migration that has already run. Probing
 * makes every call site safe BY CONSTRUCTION instead of by that coincidence.
 *
 * The DELETE after a successful probe is deliberately NOT wrapped. Nothing in
 * this repo ever DROPs these relations, so the probe/delete race is unreachable,
 * and a tolerated 42P01 there could not recover anyway — it would leave the
 * transaction aborted and resurface as a misleading 25P02. A genuine delete
 * failure must surface as itself.
 *
 * `tableName` is a fixed union, never a caller-supplied string: with
 * `to_regclass` a STALE name is indistinguishable from an absent table, so a
 * typo would become a permanent SILENT skip rather than a visible error. The
 * Mastra names come from the assistant-contract schema constants, never local
 * literals, for the same reason.
 */
export async function clearOptionalRelation(
  tx: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  tableName: OptionalRelationTable
): Promise<void> {
  const probe = await tx.query(`SELECT to_regclass('${tableName}') IS NOT NULL AS present`);
  if ((probe.rows[0] as { present?: boolean } | undefined)?.present !== true) {
    // `debug`, not `warn`: warn+ records are persisted into
    // brainstrike_diagnostic_events — one of the tables this clear is emptying.
    logger.debug('Skipped absent database table during clear', { tableName });
    return;
  }
  await tx.query(`DELETE FROM ${tableName}`);
}
