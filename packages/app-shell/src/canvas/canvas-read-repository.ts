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
import type { AssistantThreadHostCapability } from '../assistant-thread-host-context';

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

/** Latest version per canvas, newest first, from the thread's owner: its host, else history. */
export async function readThreadCanvasSummaries(
  db: CanvasReadDatabase,
  host: Pick<AssistantThreadHostCapability, 'readCanvases'> | undefined,
  threadId: string
): Promise<readonly CanvasPanelSummary[]> {
  const owned = await host?.readCanvases?.(threadId);
  if (!owned) {
    return await listThreadCanvasSummaries(db, threadId);
  }
  return [...owned.values()]
    .flatMap((versions) => {
      const latest = versions.at(-1);
      return latest
        ? [
            {
              canvasId: latest.canvasId,
              createdAt: latest.createdAt,
              latestVersion: latest.version,
              title: latest.title,
            },
          ]
        : [];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** One version's content from the thread's owner, or null when it does not exist. */
export async function readThreadCanvasVersion(
  db: CanvasReadDatabase,
  host: Pick<AssistantThreadHostCapability, 'readCanvases'> | undefined,
  threadId: string,
  canvasId: string,
  version: number
): Promise<CanvasPanelVersion | null> {
  const owned = await host?.readCanvases?.(threadId);
  if (!owned) {
    return await getCanvasVersion(db, canvasId, version);
  }
  const found = owned.get(canvasId)?.find((candidate) => candidate.version === version);
  return found
    ? {
        createdAt: found.createdAt,
        createdBy: found.createdBy,
        html: found.html,
        version: found.version,
      }
    : null;
}
