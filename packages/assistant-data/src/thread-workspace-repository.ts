import type { WorkspaceSnapshotV1 } from './thread-workspace-snapshot';

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
