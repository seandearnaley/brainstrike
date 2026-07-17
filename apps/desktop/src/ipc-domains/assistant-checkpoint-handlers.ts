import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
} from '@brainstrike/agent';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import type { CheckpointRevertDeps } from '../assistant-server/edit-checkpoint-revert';

/**
 * Injected seams so the handler is unit-testable without the real DB or the
 * reindex side effects. Production wires `resolveDatabase` to `getDatabase`,
 * `createReindexDeps` to the assistant-tools reindex seams, and the two revert
 * functions to the executor.
 */
export interface AssistantCheckpointHandlerDependencies {
  createReindexDeps: (db: EditCheckpointDatabase) => Promise<CheckpointRevertDeps>;
  resolveDatabase: () => Promise<EditCheckpointDatabase>;
  revertEntry: (
    db: EditCheckpointDatabase,
    args: { id: string; force?: boolean },
    deps: CheckpointRevertDeps
  ) => Promise<AssistantCheckpointRevertResult>;
  revertRun: (
    db: EditCheckpointDatabase,
    args: { runId: string; force?: boolean },
    deps: CheckpointRevertDeps
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
  return {
    revertEntry: async (rawPayload: unknown): Promise<AssistantCheckpointRevertResult> => {
      const id = readStringField(rawPayload, 'id');
      const force = readForce(rawPayload);
      const db = await deps.resolveDatabase();
      const reindexDeps = await deps.createReindexDeps(db);
      return deps.revertEntry(db, { force, id }, reindexDeps);
    },
    revertRun: async (rawPayload: unknown): Promise<AssistantCheckpointRevertRunResult> => {
      const runId = readStringField(rawPayload, 'runId');
      const force = readForce(rawPayload);
      const db = await deps.resolveDatabase();
      const reindexDeps = await deps.createReindexDeps(db);
      return deps.revertRun(db, { force, runId }, reindexDeps);
    },
  };
}
