import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailabilityMap,
} from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import type { CheckpointRevertDeps } from '../../assistant-server/checkpoint-reindex-deps';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import type { SnapshotRepository } from '../../assistant-server/snapshot-repository';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import {
  type AssistantCheckpointHandlerDependencies,
  createAssistantCheckpointHandlers,
} from '../../ipc-domains/assistant-checkpoint-handlers';

const fakeDb = { query: vi.fn() } as unknown as EditCheckpointDatabase;
const fakeReindexDeps = { reindex: vi.fn() } as unknown as CheckpointRevertDeps;
const fakeSnapshotService = { kind: 'service' } as unknown as SnapshotService;
const fakeSnapshotRepository = { kind: 'repository' } as unknown as SnapshotRepository;

function makeHandlers(overrides: Partial<AssistantCheckpointHandlerDependencies> = {}) {
  return createAssistantCheckpointHandlers({
    availability: overrides.availability ?? (async () => ({ byCheckpointId: {} })),
    createReindexDeps: async () => fakeReindexDeps,
    createSnapshotRepository: () => fakeSnapshotRepository,
    resolveDatabase: async () => fakeDb,
    resolveSnapshotService: overrides.resolveSnapshotService ?? (() => fakeSnapshotService),
    undoEntry:
      overrides.undoEntry ??
      (async () => ({ code: 'not_found', id: 'x', message: 'nope', ok: false })),
    undoRun: overrides.undoRun ?? (async () => ({ outcomes: [], runId: 'run-1' })),
  });
}

/** The undo-deps shape the handler must assemble for every operation. */
const expectedUndoDeps = {
  reindex: fakeReindexDeps.reindex,
  snapshotRepository: fakeSnapshotRepository,
  snapshotService: fakeSnapshotService,
};

describe('assistant-checkpoint IPC handlers', () => {
  it('forwards a valid revert-entry payload to the undo engine with assembled snapshot deps', async () => {
    const undoEntry = vi.fn(
      async (): Promise<AssistantCheckpointRevertResult> => ({
        entry: { id: 'ckpt-1' } as never,
        ok: true,
      })
    );
    const handlers = makeHandlers({ undoEntry });
    const result = await handlers.revertEntry({ force: true, id: 'ckpt-1' });
    expect(result.ok).toBe(true);
    expect(undoEntry).toHaveBeenCalledWith(fakeDb, { force: true, id: 'ckpt-1' }, expectedUndoDeps);
  });

  it('returns the structured conflict union without throwing', async () => {
    const undoEntry = vi.fn(
      async (): Promise<AssistantCheckpointRevertResult> => ({
        code: 'conflict',
        id: 'ckpt-1',
        message: 'changed',
        ok: false,
      })
    );
    const handlers = makeHandlers({ undoEntry });
    const result = await handlers.revertEntry({ id: 'ckpt-1' });
    expect(result).toEqual({ code: 'conflict', id: 'ckpt-1', message: 'changed', ok: false });
  });

  it('rejects a payload missing the id (no silent coercion)', async () => {
    const handlers = makeHandlers();
    await expect(handlers.revertEntry({})).rejects.toThrow(/id/);
  });

  it('rejects a non-boolean force', async () => {
    const handlers = makeHandlers();
    await expect(handlers.revertEntry({ force: 'yes', id: 'ckpt-1' })).rejects.toThrow(/force/);
  });

  it('forwards a revert-run payload and returns per-entry outcomes', async () => {
    const undoRun = vi.fn(
      async (): Promise<AssistantCheckpointRevertRunResult> => ({
        outcomes: [{ entry: { id: 'a' } as never, ok: true }],
        runId: 'run-1',
      })
    );
    const handlers = makeHandlers({ undoRun });
    const result = await handlers.revertRun({ runId: 'run-1' });
    expect(result.outcomes).toHaveLength(1);
    expect(undoRun).toHaveBeenCalledWith(
      fakeDb,
      { force: false, runId: 'run-1' },
      expectedUndoDeps
    );
  });

  it('serves per-thread availability and validates the threadId payload', async () => {
    const availability = vi.fn(
      async (): Promise<AssistantCheckpointUndoAvailabilityMap> => ({
        byCheckpointId: { 'ckpt-1': { restorable: true } },
      })
    );
    const handlers = makeHandlers({ availability });
    const result = await handlers.availability({ threadId: 'thread-1' });
    expect(result.byCheckpointId['ckpt-1']).toEqual({ restorable: true });
    expect(availability).toHaveBeenCalledWith(fakeDb, expectedUndoDeps, 'thread-1');
    await expect(handlers.availability({})).rejects.toThrow(/threadId/);
  });

  it('throws VISIBLY (never a silent no-op) when the snapshot service is not wired', async () => {
    const handlers = makeHandlers({ resolveSnapshotService: () => null });
    await expect(handlers.revertEntry({ id: 'ckpt-1' })).rejects.toThrow(
      /snapshot-engine-unavailable/
    );
    await expect(handlers.revertRun({ runId: 'run-1' })).rejects.toThrow(
      /snapshot-engine-unavailable/
    );
    await expect(handlers.availability({ threadId: 'thread-1' })).rejects.toThrow(
      /snapshot-engine-unavailable/
    );
  });
});
