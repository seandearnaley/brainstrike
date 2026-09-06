import {
  CANVAS_HTML_MAX_BYTES,
  CANVAS_VERSIONS_TABLE,
  canvasHtmlWithinByteCeiling,
} from '@brainstrike/assistant-contract';
import { generateWorkspaceSnapshotId } from './snapshot-repository';

export interface CanvasDatabase {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export const CANVAS_CREATED_BY_VALUES = ['assistant', 'user'] as const;
export type CanvasCreatedBy = (typeof CANVAS_CREATED_BY_VALUES)[number];

export interface CanvasVersion {
  readonly canvasId: string;
  /** Full-precision `::text` timestamp — never routed through a JS `Date`. */
  readonly createdAt: string;
  readonly createdBy: CanvasCreatedBy;
  readonly html: string;
  readonly id: string;
  readonly resourceId: string;
  readonly threadId: string;
  readonly title: string;
  readonly version: number;
}

export interface CreateCanvasInput {
  readonly createdBy: CanvasCreatedBy;
  readonly html: string;
  readonly resourceId: string;
  readonly threadId: string;
  readonly title: string;
}

export interface ApplyCanvasUpdateInput {
  readonly canvasId: string;
  readonly newString: string;
  readonly oldString: string;
  /** Mutations are scoped to the calling thread — see {@link getLatestVersionForThread}. */
  readonly threadId: string;
}

export interface RewriteCanvasInput {
  readonly canvasId: string;
  readonly html: string;
  readonly threadId: string;
}

export type CanvasRepositoryError =
  | 'ambiguous_match'
  | 'no_match'
  | 'not_found'
  | 'too_large'
  | 'version_conflict';
export interface CanvasRepositoryFailure {
  readonly error: CanvasRepositoryError;
  readonly ok: false;
}
export interface CanvasMutationSuccess {
  readonly canvasId: string;
  readonly version: number;
}
export type CanvasMutationResult = CanvasMutationSuccess | CanvasRepositoryFailure;
export type GetLatestCanvasResult = CanvasVersion | CanvasRepositoryFailure;

interface CanvasSqlRow {
  canvasId: string;
  createdAt: string;
  createdBy: string;
  html: string;
  id: string;
  resourceId: string;
  threadId: string;
  title: string;
  version: number;
}

const ROW_SELECT = `
  id AS "id",
  canvas_id AS "canvasId",
  thread_id AS "threadId",
  resource_id AS "resourceId",
  title AS "title",
  html AS "html",
  version AS "version",
  created_by AS "createdBy",
  created_at::text AS "createdAt"
`;

function assertCanvasCreatedBy(value: string, versionId: string): CanvasCreatedBy {
  if ((CANVAS_CREATED_BY_VALUES as readonly string[]).includes(value)) {
    return value as CanvasCreatedBy;
  }
  throw new Error(
    `canvas version "${versionId}" has unknown created_by value "${value}" — schema and repository vocabulary drifted`
  );
}

function toCanvasVersion(row: CanvasSqlRow): CanvasVersion {
  return {
    canvasId: row.canvasId,
    createdAt: row.createdAt,
    createdBy: assertCanvasCreatedBy(row.createdBy, row.id),
    html: row.html,
    id: row.id,
    resourceId: row.resourceId,
    threadId: row.threadId,
    title: row.title,
    version: row.version,
  };
}

async function insertVersion(
  db: CanvasDatabase,
  input: {
    readonly canvasId: string;
    readonly createdBy: CanvasCreatedBy;
    readonly html: string;
    readonly resourceId: string;
    readonly threadId: string;
    readonly title: string;
    readonly version: number;
  }
): Promise<CanvasMutationResult> {
  // The ceiling is enforced HERE, not per write path, because this is the only
  // place html reaches the text column. `create` and `rewrite` are otherwise
  // bounded by the input schema alone, and `update` composes a document larger
  // than either field it was given — one check at the choke point covers all
  // three and removes the asymmetry.
  if (!canvasHtmlWithinByteCeiling(input.html)) {
    return { error: 'too_large', ok: false };
  }
  const id = generateWorkspaceSnapshotId();
  let result: { rows: CanvasMutationSuccess[] };
  try {
    result = await db.query<CanvasMutationSuccess>(
      `INSERT INTO ${CANVAS_VERSIONS_TABLE}
         (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING canvas_id AS "canvasId", version AS "version"`,
      [
        id,
        input.canvasId,
        input.threadId,
        input.resourceId,
        input.title,
        input.html,
        input.version,
        input.createdBy,
      ]
    );
  } catch (error) {
    // Parallel tool calls can both read version N and race to insert N+1; the
    // UNIQUE (canvas_id, version) constraint makes the loser fail here. That
    // is an EXPECTED concurrency outcome, so it returns the structured
    // version_conflict (retryable) instead of surfacing a raw driver throw.
    if (isUniqueViolation(error)) {
      return { error: 'version_conflict', ok: false };
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) {
    throw new Error('canvas version INSERT returned no row');
  }
  return row;
}

/** PGlite surfaces Postgres error 23505 (unique_violation) on the thrown error. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === '23505') {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    candidate.message.includes('duplicate key value violates unique constraint')
  );
}

export async function createCanvas(
  db: CanvasDatabase,
  input: CreateCanvasInput
): Promise<CanvasMutationResult> {
  const canvasId = generateWorkspaceSnapshotId();
  return await insertVersion(db, { ...input, canvasId, version: 1 });
}

/**
 * Thread-scoped lookup: mutations must never cross threads. A canvas that
 * exists in ANOTHER thread returns the same `not_found` as a canvas that does
 * not exist at all — a distinct error would let a leaked id be used as a
 * cross-thread existence oracle (same uniform-response reasoning as the
 * brainstrike-asset protocol's 404s).
 */
export async function getLatestVersionForThread(
  db: CanvasDatabase,
  canvasId: string,
  threadId: string
): Promise<GetLatestCanvasResult> {
  const result = await db.query<CanvasSqlRow>(
    `SELECT ${ROW_SELECT}
       FROM ${CANVAS_VERSIONS_TABLE}
      WHERE canvas_id = $1 AND thread_id = $2
      ORDER BY version DESC
      LIMIT 1`,
    [canvasId, threadId]
  );
  const row = result.rows[0];
  if (!row) {
    return { error: 'not_found', ok: false };
  }
  return toCanvasVersion(row);
}

function isCanvasRepositoryFailure(
  result: GetLatestCanvasResult
): result is CanvasRepositoryFailure {
  return 'ok' in result && result.ok === false;
}

export async function applyUpdate(
  db: CanvasDatabase,
  input: ApplyCanvasUpdateInput
): Promise<CanvasMutationResult> {
  const latest = await getLatestVersionForThread(db, input.canvasId, input.threadId);
  if (isCanvasRepositoryFailure(latest)) {
    return latest;
  }

  const firstMatch = latest.html.indexOf(input.oldString);
  if (firstMatch === -1) {
    return { error: 'no_match', ok: false };
  }
  const secondMatch = latest.html.indexOf(input.oldString, firstMatch + 1);
  if (secondMatch !== -1) {
    return { error: 'ambiguous_match', ok: false };
  }

  // Reject the clearly-oversized composition BEFORE materialising it. UTF-8
  // bytes >= UTF-16 units, so a unit count over the ceiling is over it in bytes
  // too — sparing a ~14 MB intermediate on exactly the hostile path the byte
  // predicate goes to some length not to allocate for. Anything below this
  // bound still gets insertVersion's exact check.
  if (
    latest.html.length - input.oldString.length + input.newString.length >
    CANVAS_HTML_MAX_BYTES
  ) {
    return { error: 'too_large', ok: false };
  }
  const html = `${latest.html.slice(0, firstMatch)}${input.newString}${latest.html.slice(
    firstMatch + input.oldString.length
  )}`;
  return await insertVersion(db, {
    canvasId: latest.canvasId,
    createdBy: 'assistant',
    html,
    resourceId: latest.resourceId,
    threadId: latest.threadId,
    title: latest.title,
    version: latest.version + 1,
  });
}

export async function rewriteCanvas(
  db: CanvasDatabase,
  input: RewriteCanvasInput
): Promise<CanvasMutationResult> {
  const latest = await getLatestVersionForThread(db, input.canvasId, input.threadId);
  if (isCanvasRepositoryFailure(latest)) {
    return latest;
  }
  return await insertVersion(db, {
    canvasId: latest.canvasId,
    createdBy: 'assistant',
    html: input.html,
    resourceId: latest.resourceId,
    threadId: latest.threadId,
    title: latest.title,
    version: latest.version + 1,
  });
}

export interface CanvasSummary {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly version: number;
}

/** Newest-first cap on listings; exhaustion is reported, never silent. */
export const CANVAS_LIST_LIMIT = 50;

export interface CanvasListResult {
  readonly canvases: readonly CanvasSummary[];
  /** True when more canvases exist beyond {@link CANVAS_LIST_LIMIT}. */
  readonly truncated: boolean;
}

/**
 * Listings return SUMMARIES only — never `html`. A list that inlined every
 * canvas's full document would stream unbounded HTML into model context
 * (there is no per-tool output budget wired for this tool); readers fetch a
 * specific canvas when they need its content.
 */
export async function listCanvasesForThread(
  db: CanvasDatabase,
  threadId: string
): Promise<CanvasListResult> {
  interface CanvasSummaryRow {
    canvasId: string;
    createdAt: string;
    title: string;
    version: number;
  }
  const result = await db.query<CanvasSummaryRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (canvas_id)
         canvas_id AS "canvasId",
         title AS "title",
         version AS "version",
         created_at::text AS "createdAt"
       FROM ${CANVAS_VERSIONS_TABLE}
      WHERE thread_id = $1
      ORDER BY canvas_id, version DESC
     ) AS latest
     ORDER BY latest."createdAt" DESC
     LIMIT ${CANVAS_LIST_LIMIT + 1}`,
    [threadId]
  );
  const truncated = result.rows.length > CANVAS_LIST_LIMIT;
  return {
    canvases: result.rows.slice(0, CANVAS_LIST_LIMIT),
    truncated,
  };
}
