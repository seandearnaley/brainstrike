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
  kind?: string | null;
  path: string | null;
  status?: string | null;
}

function isDbRootRow(row: unknown): row is DbRootRow {
  return typeof row === 'object' && row !== null && typeof (row as DbRootRow).id === 'string';
}

function isRegistrableRoot(root: RootDescriptor): boolean {
  return root.persisted && root.permissionState !== 'unknown';
}

function buildRootPathIndexes(
  adapterRoots: readonly RootDescriptor[],
  dbRows: readonly DbRootRow[]
) {
  const dbByPath = new Map(
    dbRows.filter((r): r is DbRootRow & { path: string } => r.path !== null).map((r) => [r.path, r])
  );
  const fsaBridgeDbByPath = new Map(
    dbRows
      .filter((r): r is DbRootRow & { path: string } => r.path !== null && r.kind === 'legacy')
      .map((r) => [r.path, r])
  );
  const adapterPathCounts = new Map<string, number>();
  for (const root of adapterRoots) {
    if (isRegistrableRoot(root)) {
      adapterPathCounts.set(root.handle.path, (adapterPathCounts.get(root.handle.path) ?? 0) + 1);
    }
  }
  return { adapterPathCounts, dbByPath, fsaBridgeDbByPath };
}

function findExistingRootMatch(args: {
  adapterPathCounts: ReadonlyMap<string, number>;
  dbByPath: ReadonlyMap<string, DbRootRow & { path: string }>;
  fsaBridgeDbByPath: ReadonlyMap<string, DbRootRow & { path: string }>;
  platformKind: ReconcileRootsArgs['platformKind'];
  root: RootDescriptor;
}): DbRootRow | undefined {
  if (args.platformKind === 'path') {
    return args.dbByPath.get(args.root.handle.path);
  }
  if (args.adapterPathCounts.get(args.root.handle.path) !== 1) {
    return;
  }
  return args.fsaBridgeDbByPath.get(args.root.handle.path);
}

async function insertRoot(args: {
  platformKind: ReconcileRootsArgs['platformKind'];
  query: RootsQueryFn;
  root: RootDescriptor;
}): Promise<void> {
  await args.query(
    `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [args.root.rootId, args.platformKind, args.root.displayName, args.root.handle.path]
  );
}

async function resolvePathUniqueRace(args: {
  error: unknown;
  query: RootsQueryFn;
  root: RootDescriptor;
}): Promise<DbRootRow & { path: string }> {
  const existing = await args.query(
    'SELECT id, kind, path, status FROM roots WHERE path = $1 LIMIT 1',
    [args.root.handle.path]
  );
  const existingRow = existing.rows.filter(isDbRootRow)[0];
  if (!existingRow) {
    // Not the path race — surface the real failure.
    throw args.error;
  }
  return {
    id: existingRow.id,
    kind: existingRow.kind ?? null,
    path: args.root.handle.path,
    status: existingRow.status ?? null,
  };
}

/**
 * Reverse the fs:removeRoot disconnect transition on a remounted row: a root
 * that reconciliation just confirmed as mounted-and-granted is live again, so a
 * DB row left `status = 'disconnected'` is flipped back to 'live' when the same
 * folder is re-added (remount-by-path). The mapping is the load-bearing output
 * of reconcileRoots (file_records.root_id stamping), so a failed flip is logged
 * and swallowed rather than aborting reconciliation: the root stays excluded
 * from the assistant server's live-roots query (visible degrade, never a wrong
 * id) and the next boot's reconcile retries the flip.
 *
 * ONLY 'disconnected' is reversed. The other non-live statuses (needs-regrant,
 * snapshot-stale — migration 039) encode conditions that a bare path remount
 * does NOT clear; resurrecting them to 'live' here would skip the re-grant /
 * re-verification they demand (NO SILENT FALLBACKS). A row whose status the
 * caller's SELECT omitted is likewise left untouched.
 */
async function restoreRootLiveStatus(query: RootsQueryFn, row: DbRootRow): Promise<void> {
  if (row.status !== 'disconnected') {
    return;
  }
  try {
    await query(`UPDATE roots SET status = 'live', last_verified_at = NOW() WHERE id = $1`, [
      row.id,
    ]);
  } catch (error) {
    logger.error('Failed to restore live status on remounted root', { error, rootId: row.id });
  }
}

/**
 * Ensures a DB roots row exists for every adapter root (registration, not
 * broad reconciliation — unique legacy FSA bridges keep their legacy row ids).
 * DB roots.id is canonical for file_records.root_id; new roots are inserted under the
 * adapter's RootId so the two identities coincide. Pre-existing rows are
 * matched by path only to respect the idx_roots_path unique index; identity
 * columns (id/kind/path/display_name) are never modified, but a matched
 * 'disconnected' row's status is restored to 'live' — reconciliation is the
 * attestation that the root is mounted and granted again, reversing the
 * fs:removeRoot disconnect transition (remount-by-path); other non-live
 * statuses are left intact. Session-only roots (persisted:false) and dead handles
 * (permissionState 'unknown') are skipped — their ids never return from
 * restoreRoots(), so registering them would orphan DB rows.
 */
export async function reconcileRoots(args: ReconcileRootsArgs): Promise<ReconcileRootsResult> {
  const { adapterRoots, platformKind, query } = args;
  const mapping = new Map<string, string>();

  const result = await query('SELECT id, kind, path, status FROM roots');
  const dbRows = result.rows.filter(isDbRootRow);
  const { adapterPathCounts, dbByPath, fsaBridgeDbByPath } = buildRootPathIndexes(
    adapterRoots,
    dbRows
  );

  for (const root of adapterRoots) {
    if (!isRegistrableRoot(root)) {
      logger.warn('Skipping unregistrable root', {
        permissionState: root.permissionState,
        persisted: root.persisted,
        rootId: root.rootId,
      });
      continue;
    }
    // Desktop adapter paths are absolute filesystem identities and may match
    // any existing row. Web/FSA paths are only bare directory names, so path
    // matching is allowed only as a one-time unique legacy bridge; same-name
    // active FSA roots must remain independent by adapter root id.
    const matched = findExistingRootMatch({
      adapterPathCounts,
      dbByPath,
      fsaBridgeDbByPath,
      platformKind,
      root,
    });
    if (matched) {
      await restoreRootLiveStatus(query, matched);
      mapping.set(root.rootId, matched.id);
      continue;
    }
    try {
      await insertRoot({ platformKind, query, root });
    } catch (error) {
      if (platformKind !== 'path') {
        throw error;
      }
      // ON CONFLICT (id) does not cover the desktop path unique index: a
      // concurrent writer (another window racing this reconcile) can land a
      // same-path row between our SELECT and this INSERT. Converge on the
      // existing row instead of aborting the remaining roots.
      const existingRow = await resolvePathUniqueRace({ error, query, root });
      await restoreRootLiveStatus(query, existingRow);
      mapping.set(root.rootId, existingRow.id);
      dbByPath.set(root.handle.path, { ...existingRow, status: 'live' });
      logger.warn('Root path registered by a concurrent writer — converged on existing row', {
        dbRootId: existingRow.id,
        rootId: root.rootId,
      });
      continue;
    }
    // Keep dbByPath current so a subsequent root with the same path maps to this id
    dbByPath.set(root.handle.path, {
      id: root.rootId,
      kind: platformKind,
      path: root.handle.path,
      status: 'live',
    });
    mapping.set(root.rootId, root.rootId);
    logger.info('Registered new root', { kind: platformKind, rootId: root.rootId });
  }

  return { dbRootIdByAdapterRootId: mapping };
}
