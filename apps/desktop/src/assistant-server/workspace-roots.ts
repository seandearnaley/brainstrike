import path from 'node:path';
import type { RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('AssistantWorkspaceRoots');
// Process-lifetime revocation tombstones protect in-flight runtime snapshots.
// An id clears only after a verified live DB reload observes that exact root.
const disconnectedRootIds = new Set<string>();
const REDACTED_ROOT_ID_LOG_VALUE = { redacted: true } as const;

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
 * The active workspace roots available to the tools. Prefers the explicit
 * `workspaceRoots` list (resolved server-side from the DB roots table, so the
 * root ids match `file_records.root_id`); otherwise synthesizes a single root
 * from `workspaceRootPath` (single-root / legacy). Roots without an absolute
 * path are dropped.
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
  const single = runtimeData?.workspaceRootPath?.trim();
  if (single && path.isAbsolute(single)) {
    const resolved = path.resolve(single);
    return [{ displayName: path.basename(resolved) || resolved, path: resolved, rootId: resolved }];
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
  if (roots.length === 0) {
    throw new ToolInputError(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }

  const trimmed = normalizeExplicitRootQualifier(qualifier);
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
    throw new ToolInputError(
      `No folder "${trimmed}" in the workspace. Open folders: ${describeRoots(roots)}.`
    );
  }

  const boundRootId = runtimeData?.boundWorkspaceRootId?.trim();
  if (boundRootId) {
    const boundRoot = roots.find((root) => root.rootId === boundRootId);
    if (!boundRoot) {
      throw new ToolInputError(
        `The bound workspace root (id ${rootIdForMessage(boundRootId)}) is no longer open. Reconnect that folder before continuing this thread.`
      );
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
    logger.warn('Bound thread root is not among live workspace roots.', {
      boundWorkspaceRootId: boundRootId,
    });
    return [...roots];
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
 * On an empty result with a legacy `workspaceRootPath`, RuntimeData remains
 * unchanged so the resolver can use that single FOCUSED root. Without a legacy
 * path, an empty successful query is recorded as `workspaceRoots: []`; this is
 * the authoritative zero-root state consumed by `listWorkspaceContext`. Query
 * failures remain absent/unchanged so they cannot be mistaken for that valid
 * empty state. The main-root declaration cannot apply in degraded mode.
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
  try {
    const roots = await loadWorkspaceRootsFromDatabase(db);
    if (roots.length === 0) {
      return runtimeData.workspaceRootPath
        ? runtimeData
        : {
            ...runtimeData,
            workspaceRoots: [],
          };
    }
    return {
      ...runtimeData,
      workspaceRoots: orderWorkspaceRootsForRuntime(roots, runtimeData),
    };
  } catch (error) {
    logger.error('Failed to load workspace roots; tools fall back to the focused root.', { error });
    return runtimeData;
  }
}
