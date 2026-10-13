import path from 'node:path';
import type { RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { StoredWorkspaceRoot } from './workspace-root-types.js';

const logger = createLogger('AssistantWorkspaceRoots');
// Process-lifetime revocation tombstones protect in-flight runtime snapshots.
// An id clears only after a verified live DB reload observes that exact root.
const disconnectedRootIds = new Set<string>();
const REDACTED_ROOT_ID_LOG_VALUE = { redacted: true } as const;

export class BoundWorkspaceRootUnavailableError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = 'BoundWorkspaceRootUnavailableError';
  }
}

/**
 * A `root` that names none of a bound thread's folders (BST-1990). The run's
 * roots are the thread's folders, so the named folder may still be open in the
 * workspace; the user adds it to the thread from the composer's folder chip.
 */
export class RootNotInThreadError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = 'RootNotInThreadError';
  }
}

/** Minimal DB surface for loading roots — structural so it is trivially mockable. */
export interface WorkspaceRootsQueryable {
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
}

interface RootRow {
  displayName: string | null;
  id: string;
  path: string | null;
}

function normalizeRoot(root: RuntimeWorkspaceRoot): RuntimeWorkspaceRoot | null {
  const rootPath = root.path?.trim();
  if (!(rootPath && path.isAbsolute(rootPath))) {
    // Roots without an absolute filesystem path (e.g. web FSA handles) are not
    // addressable by the desktop fs tools, so they are dropped here.
    return null;
  }
  const resolvedPath = path.resolve(rootPath);
  const displayName = root.displayName?.trim() || path.basename(resolvedPath) || resolvedPath;
  const rootId = root.rootId?.trim() || resolvedPath;
  return { displayName, path: resolvedPath, rootId };
}

/**
 * The active workspace roots available to the tools. `workspaceRoots` is
 * resolved server-side from the DB roots table, so the root ids match
 * `file_records.root_id`. `workspaceRootPath` is renderer-selected focus state,
 * never an authorization source. Roots without an absolute path are dropped.
 */
export function getWorkspaceRoots(runtimeData: RuntimeData | undefined): RuntimeWorkspaceRoot[] {
  const explicit = runtimeData?.workspaceRoots;
  if (explicit) {
    if (explicit.length === 0 && runtimeData?.workspaceRootPath?.trim()) {
      throw new TypeError(
        'Workspace root metadata is inconsistent: an authoritative empty root list cannot include a legacy workspace path.'
      );
    }
    return explicit
      .map((root) => normalizeRoot(root))
      .filter((root): root is RuntimeWorkspaceRoot => root !== null);
  }
  if (runtimeData?.workspaceRootPath?.trim()) {
    throw new TypeError(
      'The authoritative workspace root inventory is unavailable; a focused workspace path cannot authorize tool access.'
    );
  }
  return [];
}

function describeRoots(roots: readonly RuntimeWorkspaceRoot[]): string {
  return describeRootsWithIds(roots);
}

function describeRootsWithIds(roots: readonly RuntimeWorkspaceRoot[]): string {
  const maxChars = 800;
  const fullDescription = roots
    .map((root) => `${root.displayName} (id ${rootIdForMessage(root.rootId)})`)
    .join(', ');
  if (fullDescription.length <= maxChars) {
    return fullDescription;
  }
  const descriptions: string[] = [];
  for (const root of roots) {
    const description = `${root.displayName} (id ${rootIdForMessage(root.rootId)})`;
    const candidateDescriptions = [...descriptions, description];
    const omitted = roots.length - candidateDescriptions.length;
    const overflow = `${omitted} more not shown. Call listWorkspaceContext for the complete root inventory`;
    const candidate =
      omitted === 0
        ? candidateDescriptions.join(', ')
        : `${candidateDescriptions.join(', ')}; ${overflow}`;
    if (candidate.length > maxChars) {
      break;
    }
    descriptions.push(description);
  }
  const omitted = roots.length - descriptions.length;
  const overflow = `${omitted} more not shown. Call listWorkspaceContext for the complete root inventory`;
  if (descriptions.length === 0) {
    return overflow;
  }
  return `${descriptions.join(', ')}; ${overflow}`;
}

function assertRootStillConnected(root: RuntimeWorkspaceRoot): RuntimeWorkspaceRoot {
  if (disconnectedRootIds.has(root.rootId)) {
    throw new ToolInputError(
      `Workspace root "${root.displayName}" (id ${rootIdForMessage(root.rootId)}) was disconnected during this run. Reconnect it before continuing.`
    );
  }
  return root;
}

/** A `root` that names none of the run's roots: in a bound thread, the thread's folders. */
function unknownRootRefusal(
  qualifier: string,
  roots: readonly RuntimeWorkspaceRoot[],
  bound: boolean
): ToolInputError {
  return bound
    ? new RootNotInThreadError(
        `"${qualifier}" is not one of this thread's folders: ${describeRoots(roots)}. If it is open in the workspace, the user can add it to this thread from the composer's folder chip.`
      )
    : new ToolInputError(
        `No folder "${qualifier}" in the workspace. Open folders: ${describeRoots(roots)}.`
      );
}

function boundRootNotOpen(boundRootId: string): ToolInputError {
  return new ToolInputError(
    `The bound workspace root (id ${rootIdForMessage(boundRootId)}) is no longer open. Reconnect that folder before continuing this thread.`
  );
}

function rootIdForMessage(rootId: string): string {
  return path.isAbsolute(rootId) ? 'path-backed id redacted' : rootId;
}

function rootIdForLog(root: RuntimeWorkspaceRoot): string | typeof REDACTED_ROOT_ID_LOG_VALUE {
  return path.isAbsolute(root.rootId) ? REDACTED_ROOT_ID_LOG_VALUE : root.rootId;
}

function normalizeExplicitRootQualifier(qualifier?: string | null): string | undefined {
  if (qualifier === undefined || qualifier === null) {
    return;
  }
  const trimmed = qualifier.trim();
  if (!trimmed) {
    throw new ToolInputError(
      'The "root" argument must not be blank. Omit it to use the thread-bound root, or provide an open folder name or id.'
    );
  }
  return trimmed;
}

function getValidatedBoundRootId(
  runtimeData: RuntimeData | undefined,
  hasExplicitQualifier: boolean
): string | undefined {
  const boundRootId = runtimeData?.boundWorkspaceRootId?.trim();
  if (!(boundRootId && !hasExplicitQualifier && runtimeData?.workspaceRoots === undefined)) {
    return boundRootId;
  }
  throw new ToolInputError(
    'The authoritative workspace root inventory is unavailable, so the bound thread root cannot be validated. Reload the workspace roots before continuing this thread.'
  );
}

/**
 * Resolve which root a tool call targets. `qualifier` is a root id or display
 * name (the model's "root" argument). Multi-root disambiguation:
 * - no roots → throw "no folder open"
 * - qualifier matches a rootId → that root
 * - qualifier matches exactly one displayName (case-insensitive) → that root
 * - qualifier matches several same-named roots → throw, ask for the id
 * - qualifier matches nothing → throw, list the open folders
 * - no qualifier + one root → that root
 * - no qualifier + multiple roots → throw, list the open folders
 */
export function resolveWorkspaceRoot(
  runtimeData: RuntimeData | undefined,
  qualifier?: string | null
): RuntimeWorkspaceRoot {
  const roots = getWorkspaceRoots(runtimeData);
  const trimmed = normalizeExplicitRootQualifier(qualifier);
  const boundRootId = getValidatedBoundRootId(runtimeData, trimmed !== undefined);
  if (roots.length === 0) {
    throw new ToolInputError(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }

  if (trimmed) {
    const byId = roots.find((root) => root.rootId === trimmed);
    if (byId) {
      logger.info('Resolved native workspace tool root.', {
        mode:
          runtimeData?.boundWorkspaceRootId && runtimeData.boundWorkspaceRootId !== byId.rootId
            ? 'explicit-cross-root'
            : 'explicit',
        rootId: rootIdForLog(byId),
        rootName: byId.displayName,
      });
      return assertRootStillConnected(byId);
    }
    const lower = trimmed.toLowerCase();
    const byName = roots.filter((root) => root.displayName.toLowerCase() === lower);
    if (byName.length === 1) {
      const resolved = byName[0] as RuntimeWorkspaceRoot;
      logger.info('Resolved native workspace tool root.', {
        mode:
          runtimeData?.boundWorkspaceRootId && runtimeData.boundWorkspaceRootId !== resolved.rootId
            ? 'explicit-cross-root'
            : 'explicit',
        rootId: rootIdForLog(resolved),
        rootName: resolved.displayName,
      });
      return assertRootStillConnected(resolved);
    }
    if (byName.length > 1) {
      throw new ToolInputError(
        `Multiple folders are named "${trimmed}". Use the root id instead: ${describeRootsWithIds(byName)}.`
      );
    }
    throw unknownRootRefusal(trimmed, roots, Boolean(boundRootId));
  }

  if (boundRootId) {
    const boundRoot = roots.find((root) => root.rootId === boundRootId);
    if (!boundRoot) {
      throw boundRootNotOpen(boundRootId);
    }
    logger.info('Resolved native workspace tool root.', {
      mode: 'thread-bound',
      rootId: rootIdForLog(boundRoot),
      rootName: boundRoot.displayName,
    });
    return assertRootStillConnected(boundRoot);
  }

  if (roots.length === 1) {
    const soleRoot = roots[0] as RuntimeWorkspaceRoot;
    logger.info('Resolved native workspace tool root.', {
      mode: 'sole-root',
      rootId: rootIdForLog(soleRoot),
      rootName: soleRoot.displayName,
    });
    return assertRootStillConnected(soleRoot);
  }
  throw new ToolInputError(
    `Multiple folders are open. Specify which with the "root" argument (folder name or id). Open folders: ${describeRoots(roots)}.`
  );
}

/**
 * Resolve the FOCUSED root that owns renderer-selected context. A durable
 * thread binding deliberately does not participate: selection paths and
 * Tapestry ranges are relative to `workspaceRootPath`, not the thread root.
 */
export function resolveFocusedWorkspaceRoot(
  runtimeData: RuntimeData | undefined
): RuntimeWorkspaceRoot {
  const focusedPath = runtimeData?.workspaceRootPath?.trim();
  if (!(focusedPath && path.isAbsolute(focusedPath))) {
    throw new ToolInputError(
      'The focused workspace root is unavailable. Focus an open folder before reading selected workspace context.'
    );
  }

  const resolvedFocusedPath = path.resolve(focusedPath);
  const matches = getWorkspaceRoots(runtimeData).filter(
    (root) => root.path === resolvedFocusedPath
  );
  if (matches.length === 0) {
    throw new ToolInputError(
      'The focused workspace root is not in the authoritative open-root inventory. Reload the workspace roots before reading selected workspace context.'
    );
  }
  if (matches.length > 1) {
    throw new ToolInputError(
      'The authoritative open-root inventory contains multiple entries for the focused workspace path. Reconnect the folder before reading selected workspace context.'
    );
  }
  return resolveWorkspaceRoot(runtimeData, (matches[0] as RuntimeWorkspaceRoot).rootId);
}

/**
 * Root-topology fields the search-result envelopes carry for the model
 * projections (BST-1185). `openRoots` is present only when more than one
 * folder is open (the projection's root-prefix trigger); `ambiguousRootNames`
 * lists the LOWERCASED display names shared by more than one open root, so
 * the projection can fall back to root ids for names `resolveWorkspaceRoot`
 * would reject as ambiguous — ambiguity is a property of the full open-root
 * inventory, never of one result page.
 */
export interface OpenRootTopology {
  ambiguousRootNames?: string[];
  openRoots?: number;
}

export function describeOpenRootTopology(runtimeData: RuntimeData | undefined): OpenRootTopology {
  const roots = getWorkspaceRoots(runtimeData);
  if (roots.length <= 1) {
    return {};
  }
  const countsByName = new Map<string, number>();
  for (const root of roots) {
    const key = root.displayName.toLowerCase();
    countsByName.set(key, (countsByName.get(key) ?? 0) + 1);
  }
  const ambiguousRootNames: string[] = [];
  for (const [name, count] of countsByName) {
    if (count > 1) {
      ambiguousRootNames.push(name);
    }
  }
  ambiguousRootNames.sort();
  return {
    openRoots: roots.length,
    ...(ambiguousRootNames.length > 0 ? { ambiguousRootNames } : {}),
  };
}

/**
 * Resolve an optional root selector while honoring a durable thread binding.
 * Callers whose historical omission semantics mean "all roots" use this
 * helper: an explicit selector or thread binding narrows to one root; only a
 * genuinely unbound omission remains undefined/all-roots.
 */
export function resolveOptionalWorkspaceRoot(
  runtimeData: RuntimeData | undefined,
  qualifier?: string | null
): RuntimeWorkspaceRoot | undefined {
  if (
    (qualifier !== undefined && qualifier !== null) ||
    runtimeData?.boundWorkspaceRootId?.trim()
  ) {
    return resolveWorkspaceRoot(runtimeData, qualifier);
  }
  return;
}

/** The folders a grep or glob searches. */
export type WorkspaceSearchScope =
  /** An explicit `root`: that folder. */
  | { readonly kind: 'folder'; readonly root: RuntimeWorkspaceRoot }
  /** No `root` in a bound thread: every folder of the thread. */
  | { readonly kind: 'thread'; readonly roots: RuntimeWorkspaceRoot[] }
  /** No `root` and no thread binding: every open folder. */
  | { readonly kind: 'workspace'; readonly roots: RuntimeWorkspaceRoot[] };

/**
 * Resolve what a grep or glob searches (BST-1990, D3). An explicit `root`
 * always wins. Without one, a bound thread searches every one of its folders
 * (the run's roots), after the binding is validated, and none is skipped.
 */
export function resolveWorkspaceSearchScope(
  runtimeData: RuntimeData | undefined,
  qualifier?: string | null
): WorkspaceSearchScope {
  if (qualifier !== undefined && qualifier !== null) {
    return { kind: 'folder', root: resolveWorkspaceRoot(runtimeData, qualifier) };
  }
  const roots = getWorkspaceRoots(runtimeData);
  const boundRootId = getValidatedBoundRootId(runtimeData, false);
  if (!boundRootId) {
    return { kind: 'workspace', roots };
  }
  if (!roots.some((root) => root.rootId === boundRootId)) {
    throw boundRootNotOpen(boundRootId);
  }
  return { kind: 'thread', roots: roots.map(assertRootStillConnected) };
}

/**
 * Load the active, path-backed workspace roots from the DB `roots` table. The
 * `roots.id` here is the SAME id stored on `file_records.root_id`, so search
 * results and read tools resolve against one source of truth. Web (FSA) roots
 * have a null path and are excluded — the desktop fs tools can't address them.
 */
export async function loadWorkspaceRootsFromDatabase(
  db: WorkspaceRootsQueryable
): Promise<RuntimeWorkspaceRoot[]> {
  const result = await db.query<RootRow>(
    `SELECT id, display_name AS "displayName", path
       FROM roots
      WHERE status = $1 AND path IS NOT NULL AND path <> ''
      ORDER BY created_at ASC`,
    ['live']
  );
  const roots = result.rows
    .map((row) =>
      normalizeRoot({
        displayName: row.displayName ?? '',
        path: row.path ?? '',
        rootId: row.id,
      })
    )
    .filter((root): root is RuntimeWorkspaceRoot => root !== null);
  for (const root of roots) {
    disconnectedRootIds.delete(root.rootId);
  }
  return roots;
}

/**
 * Transition the root at `rootPath` to status 'disconnected' so the assistant
 * tools (which serve only `status = 'live'` rows) stop addressing it the moment
 * the user disconnects the folder. Disconnect ≠ delete: the row and its
 * file_records/file_chunks are deliberately kept, and `reconcileRoots`
 * (app-shell) path-matches the row on re-add and restores `status = 'live'`,
 * so a remount resumes without re-indexing.
 *
 * Returns the durable ids of rows transitioned (via `RETURNING id`, since the DB
 * host protocol surfaces only `rows`, not `affectedRows`). No ids is legitimate
 * for a session-only root that never got a DB row, but for a persisted root it
 * signals a path mismatch — the caller decides whether that is worth surfacing
 * rather than swallowing it here.
 */
export async function markRootDisconnectedByPath(
  db: WorkspaceRootsQueryable,
  rootPath: string
): Promise<readonly string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE roots SET status = 'disconnected' WHERE path = $1 RETURNING id`,
    [rootPath]
  );
  const rootIds = result.rows.map((row) => row.id);
  for (const rootId of rootIds) {
    disconnectedRootIds.add(rootId);
  }
  return rootIds;
}

/** Resolve an unmounted folder's retained record with the registry's canonical matcher. */
export async function findRecordedWorkspaceRoot(
  db: WorkspaceRootsQueryable,
  existing: StoredWorkspaceRoot | undefined,
  match: (records: readonly StoredWorkspaceRoot[]) => Promise<StoredWorkspaceRoot | undefined>
): Promise<StoredWorkspaceRoot | undefined> {
  if (existing) {
    return existing;
  }
  const { rows } = await db.query<{ id: string; path: string }>(
    'SELECT id, path FROM roots WHERE path IS NOT NULL'
  );
  return await match(rows.map((row) => ({ addedAt: 0, path: row.path, rootId: row.id })));
}

/**
 * Record a mounted folder under its one id and return that id (BST-1990). On
 * desktop, Main's root registry is the only writer of `roots`.
 *
 * - A path's existing row keeps its id, so a re-added folder is the same folder
 *   and its indexed rows resume. A disconnected row becomes live again; other
 *   statuses (needs-regrant, snapshot-stale) keep waiting for their own remedies.
 * - A new path is inserted under `preferredId`, as a worktree when the active
 *   managed-worktree ledger names it.
 */
export async function recordWorkspaceRoot(
  db: WorkspaceRootsQueryable,
  root: { readonly path: string; readonly preferredId: string }
): Promise<string> {
  const existing = await db.query<{ id: string }>('SELECT id FROM roots WHERE path = $1', [
    root.path,
  ]);
  if (existing.rows.length > 1) {
    throw new Error('More than one workspace folder record exists for this path.');
  }
  const recorded = existing.rows[0];
  if (recorded) {
    await db.query(
      `UPDATE roots SET status = 'live', last_verified_at = NOW()
        WHERE id = $1 AND status = 'disconnected'`,
      [recorded.id]
    );
    return recorded.id;
  }
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
     SELECT $1,
            CASE WHEN EXISTS (
              SELECT 1 FROM brainstrike_worktrees WHERE path = $3 AND archived_at IS NULL
            ) THEN 'worktree' ELSE 'path' END,
            $2, $3, NOW()`,
    [root.preferredId, path.basename(root.path) || root.path, root.path]
  );
  return root.preferredId;
}

/**
 * Restore makes sure every mounted, persisted folder has its record. A record
 * under another id (written before Main owned `roots`) is reported, not rewritten:
 * greenfield data has no such rows to migrate (ADR-0020).
 */
export async function recordRestoredWorkspaceRoots(
  getDb: () => Promise<WorkspaceRootsQueryable>,
  roots: readonly { readonly path: string; readonly rootId: string }[]
): Promise<void> {
  if (roots.length === 0) {
    return;
  }
  try {
    const db = await getDb();
    for (const root of roots) {
      const recordedId = await recordWorkspaceRoot(db, {
        path: root.path,
        preferredId: root.rootId,
      });
      if (recordedId !== root.rootId) {
        logger.error(
          'A restored workspace folder is mounted under a different id than its record',
          {
            recordedId,
            rootId: root.rootId,
          }
        );
      }
    }
  } catch (error) {
    logger.error('Restored workspace folders could not be recorded', { error });
  }
}

/**
 * Converge the DB roots table on the AUTHORITATIVE mounted set: every
 * `status = 'live'` row whose `path` is not in `mountedPaths` is transitioned to
 * 'disconnected'. Same semantics as {@link markRootDisconnectedByPath} (rows and
 * their file_records are KEPT, so a re-add path-matches and resumes without
 * re-indexing) — this is the SET-shaped form of that transition.
 *
 * Why this exists: `reconcileRoots` (app-shell) only ever promotes
 * 'disconnected' → 'live'; the sole demotion was `fs:removeRoot`. Every path
 * that drops a root WITHOUT that IPC succeeding — a boot-time rootsList prune of
 * a vanished path, the best-effort `forgetRootInAdapter` swallowing an IPC
 * failure, a 0-row path mismatch, storage rewritten out of band — therefore
 * leaked a permanently 'live' row. Since every server-side consumer of
 * {@link loadWorkspaceRootsFromDatabase} scopes on `status = 'live'`, that row
 * kept the folder inside the assistant's addressable set (and made
 * {@link resolveWorkspaceRoot} throw "Multiple folders are open") with NO in-app
 * way to clear it: `fs:removeRoot` early-returns for a rootId absent from
 * rootsList. Convergence closes that one-way divergence.
 *
 * ONLY path-backed rows are demoted. A null/empty-path row (web FSA) cannot be
 * compared against a desktop mount set, so its state is not determinable here
 * and it is left untouched rather than guessed at — the same boundary
 * `loadWorkspaceRootsFromDatabase` draws for what the desktop tools may address.
 *
 * An empty `mountedPaths` is MEANINGFUL, not a no-op guard: no folders mounted
 * means no root may remain live.
 *
 * Returns the demoted rows (via `RETURNING`, since the DB host protocol surfaces
 * only `rows`, not `affectedRows`) so the caller can log what it converged.
 */
export async function markRootsDisconnectedExcept(
  db: WorkspaceRootsQueryable,
  mountedPaths: readonly string[]
): Promise<readonly { id: string; path: string }[]> {
  const result = await db.query<{ id: string; path: string }>(
    `UPDATE roots
        SET status = 'disconnected'
      WHERE status = 'live'
        AND path IS NOT NULL
        AND path <> ''
        AND NOT (path = ANY($1::text[]))
     RETURNING id, path`,
    [mountedPaths]
  );
  for (const row of result.rows) {
    disconnectedRootIds.add(row.id);
  }
  return result.rows;
}

/**
 * Reorder the enriched roots so the CLIENT-DECLARED MAIN root
 * (`runtimeData.mainRootId`, i.e. activeRootIds[0]) is FIRST. `roots[0]` is
 * the contract for "the assistant's operating root": hooks `primaryCwd` and
 * the model-facing "main root path" both read it. Matching:
 * 1. by durable rootId (DB `roots.id` — the common case; client + server
 *    share the id space since storage v5),
 * 2. else by resolved absolute path (`mainRootPath`) — covers legacy client
 *    ids that diverged from the DB id (see root-identity-context).
 * No match (or no declaration) keeps the DB `created_at ASC` order — the
 * legacy tiebreak — with a debug log, never a throw: the declaration is an
 * ordering PREFERENCE, not a security boundary.
 */
export function orderWorkspaceRoots(
  roots: readonly RuntimeWorkspaceRoot[],
  mainRootId: string | undefined,
  mainRootPath: string | undefined
): RuntimeWorkspaceRoot[] {
  if (roots.length <= 1) {
    return [...roots];
  }
  const trimmedId = mainRootId?.trim();
  const trimmedPath = mainRootPath?.trim();
  if (!(trimmedId || trimmedPath)) {
    return [...roots];
  }
  let index = trimmedId ? roots.findIndex((root) => root.rootId === trimmedId) : -1;
  if (index < 0 && trimmedPath && path.isAbsolute(trimmedPath)) {
    const resolvedPath = path.resolve(trimmedPath);
    index = roots.findIndex((root) => root.path === resolvedPath);
  }
  if (index < 0) {
    logger.debug('Declared main root not among live roots; keeping created_at order.', {
      mainRootId: trimmedId,
      mainRootPath: trimmedPath,
    });
    return [...roots];
  }
  const main = roots[index] as RuntimeWorkspaceRoot;
  return [main, ...roots.filter((_root, rootIndex) => rootIndex !== index)];
}

function orderWorkspaceRootsForRuntime(
  roots: readonly RuntimeWorkspaceRoot[],
  runtimeData: RuntimeData
): RuntimeWorkspaceRoot[] {
  const boundRootId = runtimeData.boundWorkspaceRootId?.trim();
  if (boundRootId) {
    const boundRootIndex = roots.findIndex((root) => root.rootId === boundRootId);
    if (boundRootIndex >= 0) {
      const boundRoot = roots[boundRootIndex] as RuntimeWorkspaceRoot;
      return [boundRoot, ...roots.filter((_root, index) => index !== boundRootIndex)];
    }
    throw new BoundWorkspaceRootUnavailableError(
      `The bound workspace root (id ${rootIdForMessage(boundRootId)}) is no longer open. Reconnect that folder before continuing this thread.`
    );
  }
  return orderWorkspaceRoots(roots, runtimeData.mainRootId, runtimeData.mainRootPath);
}

/**
 * Enrich RuntimeData with the active workspace roots so the tools become
 * multi-root aware. We resolve roots server-side from the DB so each root id is
 * the DB `roots.id` that `file_records.root_id` references — the single id
 * source shared by search-result `rootId`s and read-tool path resolution.
 * The loaded roots are then reordered so the client-declared MAIN root
 * (`mainRootId`/`mainRootPath`) is `roots[0]` (see `orderWorkspaceRoots`).
 *
 * INVARIANT: a pre-supplied `runtimeData.workspaceRoots` is treated as
 * authoritative and skips DB resolution, so any such list MUST already carry DB
 * `roots.id`s — never client/adapter ids (which differ). The desktop request
 * boundary strips client-supplied `workspaceRoots` before calling this helper;
 * pre-supplied roots are reserved for trusted in-process callers.
 *
 * An empty successful query is recorded as `workspaceRoots: []`; this is the
 * authoritative zero-root state consumed by `listWorkspaceContext`. The
 * renderer-selected `workspaceRootPath` is cleared in that state so stale
 * focus cannot conflict with the authoritative inventory or authorize a root
 * absent from the DB inventory. Query failures remain
 * absent/unchanged so they cannot be mistaken for a valid empty state; tool
 * resolution then fails closed. The main-root declaration cannot apply in
 * degraded mode.
 */
export async function enrichRuntimeDataWithWorkspaceRoots(
  runtimeData: RuntimeData | undefined,
  db: WorkspaceRootsQueryable | null | undefined
): Promise<RuntimeData | undefined> {
  if (!runtimeData || (runtimeData.workspaceRoots && runtimeData.workspaceRoots.length > 0)) {
    // Trusted to carry DB roots.id (see INVARIANT above).
    return runtimeData;
  }
  if (!db) {
    return runtimeData;
  }
  let roots: RuntimeWorkspaceRoot[];
  try {
    roots = await loadWorkspaceRootsFromDatabase(db);
  } catch (error) {
    logger.error('Failed to load workspace roots; authoritative root inventory is unavailable.', {
      error,
    });
    return runtimeData;
  }
  const orderedRoots = orderWorkspaceRootsForRuntime(roots, runtimeData);
  if (orderedRoots.length === 0) {
    const { workspaceRootPath: _staleFocusedPath, ...runtimeWithoutFocusedPath } = runtimeData;
    return {
      ...runtimeWithoutFocusedPath,
      workspaceRoots: [],
    };
  }
  return {
    ...runtimeData,
    workspaceRoots: orderedRoots,
  };
}
