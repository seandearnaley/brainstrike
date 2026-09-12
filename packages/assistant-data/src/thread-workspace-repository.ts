import type { DbHandle } from '@brainstrike/db/react';
import { coerceWorkspaceSnapshot, type WorkspaceSnapshotV1 } from './thread-workspace-snapshot';

/**
 * Per-thread workspace snapshot persistence (BST-1268, migration 094).
 * Modeled on the thread-groups/placements repository: Brainstrike-owned rows
 * keyed by `thread_id`, no FK to `mastra_threads` (a row whose thread no
 * longer exists is cascaded by `THREAD_DELETE_SIDECAR_TABLES`). Writes require
 * the live native owner so a queued outgoing save cannot recreate a deleted row.
 * A WeakMap keeps one repository instance per `DbHandle`; both boundaries
 * validate strictly. Writes are single-statement upserts — atomic without
 * needing `DbHandle.transaction`.
 */
export interface ThreadWorkspaceRepository {
  getThreadWorkspace(threadId: string): Promise<WorkspaceSnapshotV1 | null>;
  getThreadWorkspaces(threadIds: readonly string[]): Promise<Map<string, WorkspaceSnapshotV1>>;
  setThreadWorkspace(
    threadId: string,
    resourceId: string,
    snapshot: WorkspaceSnapshotV1
  ): Promise<void>;
}

/** A queued save lost its native owner through deletion or an ownership change. */
export class ThreadWorkspaceUnavailableError extends Error {
  constructor(readonly threadId: string) {
    super('The thread workspace owner no longer exists or its ownership changed.');
    this.name = 'ThreadWorkspaceUnavailableError';
  }
}

const repositoryCache = new WeakMap<DbHandle, ThreadWorkspaceRepository>();

interface WorkspaceRow {
  payload: unknown;
  threadId: unknown;
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`A ${label} is required to persist a thread workspace.`);
  }
  return trimmed;
}

export function createThreadWorkspaceRepository(database: DbHandle): ThreadWorkspaceRepository {
  const cached = repositoryCache.get(database);
  if (cached) {
    return cached;
  }

  const repository: ThreadWorkspaceRepository = {
    async getThreadWorkspace(threadId) {
      const id = requireId(threadId, 'thread id');
      const result = await database.query<WorkspaceRow>(
        `SELECT thread_id AS "threadId", payload FROM brainstrike_assistant_thread_workspaces
         WHERE thread_id = $1`,
        [id]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return coerceWorkspaceSnapshot(row.payload);
    },

    async getThreadWorkspaces(threadIds) {
      const ids = threadIds.map((threadId) => requireId(threadId, 'thread id'));
      const snapshots = new Map<string, WorkspaceSnapshotV1>();
      if (ids.length === 0) {
        return snapshots;
      }
      const result = await database.query<WorkspaceRow>(
        `SELECT thread_id AS "threadId", payload FROM brainstrike_assistant_thread_workspaces
         WHERE thread_id = ANY($1)`,
        [ids]
      );
      for (const row of result.rows) {
        if (typeof row.threadId === 'string') {
          snapshots.set(row.threadId, coerceWorkspaceSnapshot(row.payload));
        }
      }
      return snapshots;
    },

    async setThreadWorkspace(threadId, resourceId, snapshot) {
      const id = requireId(threadId, 'thread id');
      const resource = requireId(resourceId, 'resource id');
      // Serialize explicitly: handing the driver a pre-stringified JSONB value
      // keeps the write shape identical across PGlite and bridge drivers.
      const result = await database.query(
        `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload, updated_at)
         SELECT id, "resourceId", $3::jsonb, NOW() FROM mastra_threads
         WHERE id = $1 AND "resourceId" = $2
         ON CONFLICT (thread_id) DO UPDATE
           SET resource_id = EXCLUDED.resource_id,
               payload = EXCLUDED.payload,
               updated_at = NOW()
         RETURNING thread_id`,
        [id, resource, JSON.stringify(snapshot)]
      );
      if (result.rows.length !== 1) {
        throw new ThreadWorkspaceUnavailableError(id);
      }
    },
  };

  repositoryCache.set(database, repository);
  return repository;
}
