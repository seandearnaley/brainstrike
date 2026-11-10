import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Damages a closed state DB the way StateStore's i3-corruption proof does: one bit of a
 * unique-index cell, so the table pages still read and `integrity_check` fails.
 *
 * Call it only after the app has closed. The store checkpoints its WAL into `state.db` when it
 * closes; a host that ended without closing it leaves the rows in the WAL, where a changed byte
 * of `state.db` damages nothing (BST-2472). This throws unless `integrity_check` then reports
 * the damage, so that case fails here instead of passing silently.
 */
export function corruptRunIndex(file: string): { offset: number; value: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  let offset: number;
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
    const leaf = Number(
      db
        .prepare(
          "SELECT pageno FROM dbstat WHERE name='sqlite_autoindex_run_events_1' AND pagetype='leaf' ORDER BY pageno"
        )
        .get()?.['pageno']
    );
    if (!(Number.isInteger(pageSize) && pageSize > 0 && Number.isInteger(leaf) && leaf > 0)) {
      throw new Error(
        `The state DB has no run-event index leaf to damage (page size ${pageSize}, leaf page ${leaf}).`
      );
    }
    offset = leaf * pageSize - 3;
  } finally {
    db.close();
  }
  const bytes = readFileSync(file);
  const previous = bytes[offset];
  if (previous === undefined) {
    throw new Error(
      `The index cell at byte ${offset} lies outside the ${bytes.length}-byte state DB, so its rows are still in the WAL: the agent host ended without closing its store.`
    );
  }
  const value = previous ^ 1;
  bytes[offset] = value;
  writeFileSync(file, bytes);
  const damaged = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = damaged.prepare('PRAGMA integrity_check').all();
    if (rows.length === 1 && rows[0]?.['integrity_check'] === 'ok') {
      throw new Error(
        `Changing byte ${offset} of the state DB damaged nothing SQLite reads, so that page's current copy is in the WAL: the agent host ended without closing its store.`
      );
    }
  } finally {
    damaged.close();
  }
  return { offset, value };
}
