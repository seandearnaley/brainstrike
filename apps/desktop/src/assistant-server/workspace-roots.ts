import path from 'node:path';
import type { RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('AssistantWorkspaceRoots');

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
  if (explicit && explicit.length > 0) {
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
  return roots.map((root) => root.displayName).join(', ');
}

function describeRootsWithIds(roots: readonly RuntimeWorkspaceRoot[]): string {
  return roots.map((root) => `${root.displayName} (id ${root.rootId})`).join(', ');
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
    throw new Error(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }

  const trimmed = qualifier?.trim();
  if (trimmed) {
    const byId = roots.find((root) => root.rootId === trimmed);
    if (byId) {
      return byId;
    }
    const lower = trimmed.toLowerCase();
    const byName = roots.filter((root) => root.displayName.toLowerCase() === lower);
    if (byName.length === 1) {
      return byName[0] as RuntimeWorkspaceRoot;
    }
    if (byName.length > 1) {
      throw new Error(
        `Multiple folders are named "${trimmed}". Use the root id instead: ${describeRootsWithIds(byName)}.`
      );
    }
    throw new Error(
      `No folder "${trimmed}" in the workspace. Open folders: ${describeRoots(roots)}.`
    );
  }

  if (roots.length === 1) {
    return roots[0] as RuntimeWorkspaceRoot;
  }
  throw new Error(
    `Multiple folders are open. Specify which with the "root" argument (folder name or id). Open folders: ${describeRoots(roots)}.`
  );
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
  return result.rows
    .map((row) =>
      normalizeRoot({
        displayName: row.displayName ?? '',
        path: row.path ?? '',
        rootId: row.id,
      })
    )
    .filter((root): root is RuntimeWorkspaceRoot => root !== null);
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
 * `roots.id`s — never client/adapter ids (which differ). Today nothing on the
 * client populates `workspaceRoots`, so the DB path always runs; this contract
 * keeps a future client from silently diverging the two id sources.
 *
 * On an empty result or a query failure we leave RuntimeData unchanged so the
 * resolver falls back to the single `workspaceRootPath` (the FOCUSED root —
 * degraded mode; the main-root declaration cannot apply there) — logged,
 * never silent.
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
      return runtimeData;
    }
    return {
      ...runtimeData,
      workspaceRoots: orderWorkspaceRoots(roots, runtimeData.mainRootId, runtimeData.mainRootPath),
    };
  } catch (error) {
    logger.error('Failed to load workspace roots; tools fall back to the focused root.', { error });
    return runtimeData;
  }
}
