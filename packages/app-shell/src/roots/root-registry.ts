import type { RootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('RootRegistry');

export type RootsQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface ReconcileRootsArgs {
  adapterRoots: readonly RootDescriptor[];
  platformKind: 'fsa' | 'path';
  query: RootsQueryFn;
}

export interface ReconcileRootsResult {
  dbRootIdByAdapterRootId: Map<string, string>;
}

interface DbRootRow {
  id: string;
  path: string | null;
}

function isDbRootRow(row: unknown): row is DbRootRow {
  return typeof row === 'object' && row !== null && typeof (row as DbRootRow).id === 'string';
}

/**
 * Ensures a DB roots row exists for every adapter root (registration, not
 * reconciliation — GREENFIELD, no legacy kind-updates). DB roots.id is
 * canonical for file_records.root_id; new roots are inserted under the
 * adapter's RootId so the two identities coincide. Pre-existing rows are
 * matched by path only to respect the idx_roots_path unique index and are
 * never modified. Session-only roots (persisted:false) and dead handles
 * (permissionState 'unknown') are skipped — their ids never return from
 * restoreRoots(), so registering them would orphan DB rows.
 */
export async function reconcileRoots(args: ReconcileRootsArgs): Promise<ReconcileRootsResult> {
  const { adapterRoots, platformKind, query } = args;
  const mapping = new Map<string, string>();

  const result = await query('SELECT id, path FROM roots');
  const dbRows = result.rows.filter(isDbRootRow);
  const dbByPath = new Map(
    dbRows.filter((r): r is DbRootRow & { path: string } => r.path !== null).map((r) => [r.path, r])
  );

  for (const root of adapterRoots) {
    if (!root.persisted || root.permissionState === 'unknown') {
      logger.warn('Skipping unregistrable root', {
        permissionState: root.permissionState,
        persisted: root.persisted,
        rootId: root.rootId,
      });
      continue;
    }
    // Adapter "path": bare dir name on web, absolute path on desktop — the
    // same value migration 038 backfilled into roots.path from source_root_path.
    const matched = dbByPath.get(root.handle.path);
    if (matched) {
      mapping.set(root.rootId, matched.id);
      continue;
    }
    await query(
      `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [root.rootId, platformKind, root.displayName, root.handle.path]
    );
    // Keep dbByPath current so a subsequent root with the same path maps to this id
    dbByPath.set(root.handle.path, { id: root.rootId, path: root.handle.path });
    mapping.set(root.rootId, root.rootId);
    logger.info('Registered new root', { rootId: root.rootId, kind: platformKind });
  }

  return { dbRootIdByAdapterRootId: mapping };
}
