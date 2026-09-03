/**
 * The root cascade-delete seam used by the sidebar's disconnect flow.
 *
 * Lives in its own module rather than beside `RootLayoutContent`: that file is a
 * component module and the Fast Refresh module-boundary contract
 * (`react-refresh/only-export-components`) requires a component module to export
 * only components — a shared function exported next to one silently breaks
 * Fast Refresh for the whole file. See docs/agents/ci-quality.md.
 */
import type { DbHandle } from '@brainstrike/db/react';

/**
 * Reads the affected-row count from a DML query result across driver shapes:
 * PGlite populates `affectedRows`; node-pg-style bridges use `rowCount`.
 * Returns `null` when neither is present so callers can distinguish
 * "positively zero rows" from "the driver did not report a count" and avoid a
 * false abort on a bridge that strips the field.
 */
function readAffectedRows(result: unknown): number | null {
  const shaped = result as { affectedRows?: unknown; rowCount?: unknown };
  if (typeof shaped.affectedRows === 'number') {
    return shaped.affectedRows;
  }
  if (typeof shaped.rowCount === 'number') {
    return shaped.rowCount;
  }
  return null;
}

/**
 * Deletes a root's `roots` row (cascading file_records + chunks via migration
 * 039's ON DELETE CASCADE). `roots.id` is a uuidv7, but the disconnect flow
 * passes a path as the id for legacy/unregistered roots (the sidebar falls
 * back to `handle.path` when `rootIdByPath` has no entry), so the row must be
 * matched by `id` OR `path` — `path` is uniquely indexed. A delete that
 * positively affects zero rows THROWS: the seam's contract is "never a silent
 * no-op", so an unconfirmed delete must abort the disconnect rather than let
 * the user believe data was removed while UUID-keyed rows survive.
 */
export async function deleteRootDataFromDb(db: DbHandle, rootIdOrPath: string): Promise<void> {
  const result = await db.query('DELETE FROM roots WHERE id = $1 OR path = $1', [rootIdOrPath]);
  if (readAffectedRows(result) === 0) {
    throw new Error(
      `Root data deletion matched no rows for "${rootIdOrPath}" — refusing to report a silent success.`
    );
  }
}
