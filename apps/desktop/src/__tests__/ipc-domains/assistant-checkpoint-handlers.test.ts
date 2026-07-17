import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
} from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import type { CheckpointRevertDeps } from '../../assistant-server/edit-checkpoint-revert';
import { createAssistantCheckpointHandlers } from '../../ipc-domains/assistant-checkpoint-handlers';

const fakeDb = { query: vi.fn() } as unknown as EditCheckpointDatabase;
const fakeReindexDeps = { reindex: vi.fn() } as unknown as CheckpointRevertDeps;

function makeHandlers(overrides: {
  revertEntry?: (
    db: EditCheckpointDatabase,
    args: { id: string; force?: boolean },
    deps: CheckpointRevertDeps
  ) => Promise<AssistantCheckpointRevertResult>;
  revertRun?: (
    db: EditCheckpointDatabase,
    args: { runId: string; force?: boolean },
    deps: CheckpointRevertDeps
  ) => Promise<AssistantCheckpointRevertRunResult>;
}) {
  return createAssistantCheckpointHandlers({
    createReindexDeps: async () => fakeReindexDeps,
    resolveDatabase: async () => fakeDb,
    revertEntry:
      overrides.revertEntry ??
      (async () => ({ code: 'not_found', id: 'x', message: 'nope', ok: false })),
    revertRun: overrides.revertRun ?? (async () => ({ outcomes: [], runId: 'run-1' })),
  });
}

describe('assistant-checkpoint IPC handlers', () => {
  it('forwards a valid revert-entry payload to the executor', async () => {
    const revertEntry = vi.fn(
      async (): Promise<AssistantCheckpointRevertResult> => ({
        entry: { id: 'ckpt-1' } as never,
        ok: true,
      })
    );
    const handlers = makeHandlers({ revertEntry });
    const result = await handlers.revertEntry({ force: true, id: 'ckpt-1' });
    expect(result.ok).toBe(true);
    expect(revertEntry).toHaveBeenCalledWith(
      fakeDb,
      { force: true, id: 'ckpt-1' },
      fakeReindexDeps
    );
  });

  it('returns the structured conflict union without throwing', async () => {
    const revertEntry = vi.fn(
      async (): Promise<AssistantCheckpointRevertResult> => ({
        code: 'conflict',
        id: 'ckpt-1',
        message: 'changed',
        ok: false,
      })
    );
    const handlers = makeHandlers({ revertEntry });
    const result = await handlers.revertEntry({ id: 'ckpt-1' });
    expect(result).toEqual({ code: 'conflict', id: 'ckpt-1', message: 'changed', ok: false });
  });

  it('rejects a payload missing the id (no silent coercion)', async () => {
    const handlers = makeHandlers({});
    await expect(handlers.revertEntry({})).rejects.toThrow(/id/);
  });

  it('rejects a non-boolean force', async () => {
    const handlers = makeHandlers({});
    await expect(handlers.revertEntry({ force: 'yes', id: 'ckpt-1' })).rejects.toThrow(/force/);
  });

  it('forwards a revert-run payload and returns per-entry outcomes', async () => {
    const revertRun = vi.fn(
      async (): Promise<AssistantCheckpointRevertRunResult> => ({
        outcomes: [{ entry: { id: 'a' } as never, ok: true }],
        runId: 'run-1',
      })
    );
    const handlers = makeHandlers({ revertRun });
    const result = await handlers.revertRun({ runId: 'run-1' });
    expect(result.outcomes).toHaveLength(1);
    expect(revertRun).toHaveBeenCalledWith(
      fakeDb,
      { force: false, runId: 'run-1' },
      fakeReindexDeps
    );
  });
});
