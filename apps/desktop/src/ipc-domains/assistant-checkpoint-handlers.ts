import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailabilityMap,
} from '@brainstrike/agent';
import type { CheckpointRevertDeps } from '../assistant-server/checkpoint-reindex-deps';
import type { CheckpointUndoDeps } from '../assistant-server/checkpoint-snapshot-undo';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import type { SnapshotRepository } from '../assistant-server/snapshot-repository';
import type { SnapshotService } from '../assistant-server/snapshot-service';

/**
 * Injected seams so the handler is unit-testable without the real DB, the
 * snapshot service, or the reindex side effects. Production wires
 * `resolveDatabase` to `getDatabase`, `createReindexDeps` to the
 * assistant-tools reindex seams, `resolveSnapshotService` /
 * `createSnapshotRepository` to the ONE app-lifetime snapshot backbone
 * (lazily — the service is constructed at app-ready, after IPC
 * registration), and the three operations to the snapshot undo engine
 * (`checkpoint-snapshot-undo.ts`).
 */
export interface AssistantCheckpointHandlerDependencies {
  availability: (
    db: EditCheckpointDatabase,
    deps: CheckpointUndoDeps,
    threadId: string
  ) => Promise<AssistantCheckpointUndoAvailabilityMap>;
  createReindexDeps: (db: EditCheckpointDatabase) => Promise<CheckpointRevertDeps>;
  createSnapshotRepository: (db: EditCheckpointDatabase) => SnapshotRepository;
  resolveDatabase: () => Promise<EditCheckpointDatabase>;
  resolveSnapshotService: () => SnapshotService | null;
  undoEntry: (
    db: EditCheckpointDatabase,
    args: { id: string; force?: boolean },
    deps: CheckpointUndoDeps
  ) => Promise<AssistantCheckpointRevertResult>;
  undoRun: (
    db: EditCheckpointDatabase,
    args: { runId: string; force?: boolean },
    deps: CheckpointUndoDeps
  ) => Promise<AssistantCheckpointRevertRunResult>;
}

function readStringField(payload: unknown, field: string): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`assistant-checkpoint payload must be an object with a "${field}".`);
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`assistant-checkpoint payload requires a non-empty "${field}" string.`);
  }
  return value;
}

function readForce(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const value = (payload as Record<string, unknown>)['force'];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error('assistant-checkpoint payload "force" must be a boolean when present.');
  }
  return value;
}

export function createAssistantCheckpointHandlers(deps: AssistantCheckpointHandlerDependencies) {
  async function buildUndoDeps(db: EditCheckpointDatabase): Promise<CheckpointUndoDeps> {
    const service = deps.resolveSnapshotService();
    if (!service) {
      // Visible wiring failure, never a silent no-op: the service exists for
      // the whole app lifetime once app-ready construction ran.
      throw new Error(
        'snapshot-engine-unavailable: the workspace snapshot service is not running. ' +
          'Restart the app; if this persists it is a wiring bug.'
      );
    }
    const reindexDeps = await deps.createReindexDeps(db);
    return {
      reindex: reindexDeps.reindex,
      snapshotRepository: deps.createSnapshotRepository(db),
      snapshotService: service,
    };
  }

  return {
    availability: async (rawPayload: unknown): Promise<AssistantCheckpointUndoAvailabilityMap> => {
      const threadId = readStringField(rawPayload, 'threadId');
      const db = await deps.resolveDatabase();
      return deps.availability(db, await buildUndoDeps(db), threadId);
    },
    revertEntry: async (rawPayload: unknown): Promise<AssistantCheckpointRevertResult> => {
      const id = readStringField(rawPayload, 'id');
      const force = readForce(rawPayload);
      const db = await deps.resolveDatabase();
      return deps.undoEntry(db, { force, id }, await buildUndoDeps(db));
    },
    revertRun: async (rawPayload: unknown): Promise<AssistantCheckpointRevertRunResult> => {
      const runId = readStringField(rawPayload, 'runId');
      const force = readForce(rawPayload);
      const db = await deps.resolveDatabase();
      return deps.undoRun(db, { force, runId }, await buildUndoDeps(db));
    },
  };
}
