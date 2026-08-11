/**
 * Renderer-side READ access to canvas documents (BST-1173).
 *
 * Mirrors the SQL shapes of the desktop write repository
 * (`apps/desktop/src/assistant-server/canvas-repository.ts`) against the same
 * `brainstrike_canvas_versions` table (migration 082), but is strictly
 * read-only: all writes go through the `brainstrike.manageCanvas` tool in the
 * assistant server. Works on both targets — the table exists wherever the
 * migrations ran (desktop DB host, web renderer PGlite).
 *
 * SQL strings are BUILT INSIDE the functions (module-scope contract-constant
 * reads are the chunk-init hazard class guarded by
 * verify-mastra-schema-init-order).
 */
import { CANVAS_VERSIONS_TABLE } from '@brainstrike/assistant-contract';

export interface CanvasReadDatabase {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface CanvasPanelSummary {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly latestVersion: number;
  readonly title: string;
}

export interface CanvasPanelVersion {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly html: string;
  readonly version: number;
}

/** Latest version per canvas in the thread, newest first. */
export async function listThreadCanvasSummaries(
  db: CanvasReadDatabase,
  threadId: string
): Promise<readonly CanvasPanelSummary[]> {
  const result = await db.query<CanvasPanelSummary>(
    `SELECT * FROM (
       SELECT DISTINCT ON (canvas_id)
         canvas_id AS "canvasId",
         title AS "title",
         version AS "latestVersion",
         created_at::text AS "createdAt"
       FROM ${CANVAS_VERSIONS_TABLE}
      WHERE thread_id = $1
      ORDER BY canvas_id, version DESC
     ) AS latest
     ORDER BY latest."createdAt" DESC`,
    [threadId]
  );
  return result.rows;
}

/** One specific version's content, or `null` when it does not exist. */
export async function getCanvasVersion(
  db: CanvasReadDatabase,
  canvasId: string,
  version: number
): Promise<CanvasPanelVersion | null> {
  const result = await db.query<CanvasPanelVersion>(
    `SELECT
       html AS "html",
       version AS "version",
       created_by AS "createdBy",
       created_at::text AS "createdAt"
     FROM ${CANVAS_VERSIONS_TABLE}
    WHERE canvas_id = $1 AND version = $2
    LIMIT 1`,
    [canvasId, version]
  );
  return result.rows[0] ?? null;
}
