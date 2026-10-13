import { createLogger } from '@brainstrike/logging';
import type { RootDescriptor } from '@brainstrike/types';

const logger = createLogger('RootRegistry');

export type RootsQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface ReconcileRootsArgs {
  adapterRoots: readonly RootDescriptor[];
  /**
   * Paths of managed worktrees (from `window.worktrees.listManagedPaths()`). A
   * root at one of these paths is inserted with
   * `kind: 'worktree'` instead of `platformKind`, so the background-indexing
   * default [D8] and (eventually) the Explorer can tell it apart from a
   * folder the user chose via the OS picker. Absent on web (no bridge) — the
   * platform kind then applies, exactly as before this change.
   */
  managedWorktreePaths?: ReadonlySet<string>;
  /**
   * Whether the managed-worktree path set is authoritative. Defaults to true
   * for direct/test callers; the renderer passes false until its first
   * successful desktop ledger read.
   */
  managedWorktreePathsKnown?: boolean;
  platformKind: 'fsa' | 'path';
  query: RootsQueryFn;
}

export interface ReconcileRootsResult {
  dbRootIdByAdapterRootId: Map<string, string>;
  /**
   * The DB `roots.kind` value associated with each adapter root id. Existing
   * rows retain their persisted kind; this map is a read-through only.
   */
  dbRootKindByAdapterRootId: Map<string, string>;
  /**
   * Adapter root ids this call caused a NEW `roots` row to appear for — a
   * genuine `insertRoot` (or the concurrent-writer race that converges onto a
   * row another window's insert just landed; that row is equally new to
   * `loadRoots()`'s cache). Excludes every `matched` root (line ~202 above):
   * an already-existing row reconciliation only path-matched and possibly
   * flipped back to `'live'`, which the git inventory has already discovered
   * via a prior build. This is the insert-vs-match signal
   * `use-roots-reconciliation.ts`'s boot discovery nudge gates on — an
   * ordinary boot with only already-registered roots has nothing new for the
   * inventory to arm a watcher for, so it must not fire the nudge.
   */
  insertedAdapterRootIds: Set<string>;
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
  kind: 'fsa' | 'path' | 'worktree';
  query: RootsQueryFn;
  root: RootDescriptor;
}): Promise<void> {
  await args.query(
    `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [args.root.rootId, args.kind, args.root.displayName, args.root.handle.path]
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
 *
 * Returns whether the row was ACTUALLY flipped — the caller needs this to
 * decide whether this root just became newly addressable (BST-1400 item 11
 * review fold-in): `apps/desktop/src/assistant-server/workspace-roots.ts`'s
 * inventory query is `WHERE status = 'live'`, so a 'disconnected' row is
 * outside its view until this flip, and re-adding a previously-disconnected
 * root must be treated the same as inserting a brand-new one for the
 * discovery-nudge gate — the exact flow BST-1400 item 1 exists to support.
 */
async function restoreRootLiveStatus(query: RootsQueryFn, row: DbRootRow): Promise<boolean> {
  if (row.status !== 'disconnected') {
    return false;
  }
  try {
    await query(`UPDATE roots SET status = 'live', last_verified_at = NOW() WHERE id = $1`, [
      row.id,
    ]);
    return true;
  } catch (error) {
    logger.error('Failed to restore live status on remounted root', { error, rootId: row.id });
    // A failed flip leaves the row 'disconnected' — still outside the
    // inventory's view, so it must not count as newly addressable either.
    return false;
  }
}

/**
 * The host (desktop Main's root registry) records every mounted folder under its
 * one id (BST-1990), so reconciliation only maps adapter roots onto those records:
 * no insert, no status change. A mounted folder with no record is an error.
 */
export async function mapHostRecordedRoots(
  args: Pick<ReconcileRootsArgs, 'adapterRoots' | 'platformKind'>
): Promise<ReconcileRootsResult> {
  const mapping = new Map<string, string>();
  const kinds = new Map<string, string>();
  for (const root of args.adapterRoots.filter(isRegistrableRoot)) {
    // Main committed this descriptor before Add/restore returned; no second SQL identity lookup.
    mapping.set(root.rootId, root.rootId);
    kinds.set(root.rootId, root.kind);
  }
  return {
    dbRootIdByAdapterRootId: mapping,
    dbRootKindByAdapterRootId: kinds,
    insertedAdapterRootIds: new Set(),
  };
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
  const { adapterRoots, managedWorktreePaths, platformKind, query } = args;
  const managedWorktreePathsKnown = args.managedWorktreePathsKnown ?? true;
  const mapping = new Map<string, string>();
  const dbRootKindByAdapterRootId = new Map<string, string>();
  const insertedAdapterRootIds = new Set<string>();

  const result = await query('SELECT id, kind, path, status FROM roots');
  const dbRows = result.rows.filter(isDbRootRow);
  const { adapterPathCounts, dbByPath, fsaBridgeDbByPath } = buildRootPathIndexes(
    adapterRoots,
    dbRows
  );

  for (const root of adapterRoots) {
    const rootPath = root.handle.path;
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
      // eslint-disable-next-line react-doctor/async-await-in-loop -- root registration is intentionally serial: dbByPath/mapping are mutated per iteration for a subsequent same-path root to read, and `query` is a single-connection sequential DB handle throughout this loop already.
      const restoredToLive = await restoreRootLiveStatus(query, matched);
      mapping.set(root.rootId, matched.id);
      dbRootKindByAdapterRootId.set(root.rootId, matched.kind ?? platformKind);
      // A matched row that was already 'live' is nothing new — the inventory
      // has seen it. One just flipped from 'disconnected' is NOT: it was
      // outside the inventory's `WHERE status = 'live'` view a moment ago
      // (BST-1400 item 11 review fold-in — see restoreRootLiveStatus's doc).
      if (restoredToLive) {
        insertedAdapterRootIds.add(root.rootId);
      }
      continue;
    }
    if (!managedWorktreePathsKnown) {
      logger.warn('Deferring new root insert: managed worktree set is unknown', {
        rootId: root.rootId,
      });
      continue;
    }
    const kind = managedWorktreePaths?.has(rootPath) ? 'worktree' : platformKind;
    try {
      await insertRoot({ kind, query, root });
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
      dbRootKindByAdapterRootId.set(root.rootId, existingRow.kind ?? platformKind);
      dbByPath.set(rootPath, { ...existingRow, status: 'live' });
      // A concurrent writer's row, but still NEW relative to what any
      // already-running inventory build has seen — counts as inserted.
      insertedAdapterRootIds.add(root.rootId);
      logger.warn('Root path registered by a concurrent writer — converged on existing row', {
        dbRootId: existingRow.id,
        rootId: root.rootId,
      });
      continue;
    }
    // Keep dbByPath current so a subsequent root with the same path maps to this id
    dbByPath.set(rootPath, {
      id: root.rootId,
      kind,
      path: rootPath,
      status: 'live',
    });
    mapping.set(root.rootId, root.rootId);
    dbRootKindByAdapterRootId.set(root.rootId, kind);
    insertedAdapterRootIds.add(root.rootId);
    logger.info('Registered new root', { kind, rootId: root.rootId });
  }

  return { dbRootIdByAdapterRootId: mapping, dbRootKindByAdapterRootId, insertedAdapterRootIds };
}
