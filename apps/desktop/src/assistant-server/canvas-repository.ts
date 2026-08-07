import { CANVAS_VERSIONS_TABLE } from '@brainstrike/assistant-contract';
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
}

export interface RewriteCanvasInput {
  readonly canvasId: string;
  readonly html: string;
}

export type CanvasRepositoryError = 'ambiguous_match' | 'no_match' | 'not_found';
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
): Promise<CanvasMutationSuccess> {
  const id = generateWorkspaceSnapshotId();
  const result = await db.query<CanvasMutationSuccess>(
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
  const row = result.rows[0];
  if (!row) {
    throw new Error('canvas version INSERT returned no row');
  }
  return row;
}

export async function createCanvas(
  db: CanvasDatabase,
  input: CreateCanvasInput
): Promise<CanvasMutationSuccess> {
  const canvasId = generateWorkspaceSnapshotId();
  return await insertVersion(db, { ...input, canvasId, version: 1 });
}

export async function getLatestVersion(
  db: CanvasDatabase,
  canvasId: string
): Promise<GetLatestCanvasResult> {
  const result = await db.query<CanvasSqlRow>(
    `SELECT ${ROW_SELECT}
       FROM ${CANVAS_VERSIONS_TABLE}
      WHERE canvas_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [canvasId]
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
  const latest = await getLatestVersion(db, input.canvasId);
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
  const latest = await getLatestVersion(db, input.canvasId);
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

export async function listCanvasesForThread(
  db: CanvasDatabase,
  threadId: string
): Promise<readonly CanvasVersion[]> {
  const result = await db.query<CanvasSqlRow>(
    `SELECT DISTINCT ON (canvas_id) ${ROW_SELECT}
       FROM ${CANVAS_VERSIONS_TABLE}
      WHERE thread_id = $1
      ORDER BY canvas_id, version DESC`,
    [threadId]
  );
  return result.rows.map(toCanvasVersion);
}
