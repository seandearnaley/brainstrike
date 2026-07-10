import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import { useEditCheckpoints } from '../hooks/use-edit-checkpoints';

type CheckpointBridge = NonNullable<Window['assistantCheckpoints']>;

function makeEntry(
  overrides: Partial<AssistantEditCheckpointRecord> & { id: string; toolCallId: string }
): AssistantEditCheckpointRecord {
  return {
    afterExisted: true,
    afterHash: 'after',
    beforeExisted: true,
    beforeHash: 'before',
    beforeSize: 10,
    captureStatus: 'ok',
    fromPath: null,
    occurredAt: '2026-07-10T00:00:00.000Z',
    op: 'write',
    path: 'src/file.ts',
    resourceId: 'resource-1',
    revertedAt: null,
    rootId: 'root-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolName: 'brainstrike.writeWorkspaceFile',
    ...overrides,
  };
}

function repositoryReturning(
  listThreadCheckpoints: (threadId: string) => Promise<readonly AssistantEditCheckpointRecord[]>
): AssistantThreadRepository {
  return { listThreadCheckpoints } as unknown as AssistantThreadRepository;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'assistantCheckpoints');
});

function stubBridge(bridge: CheckpointBridge): void {
  window.assistantCheckpoints = bridge;
}

describe('useEditCheckpoints', () => {
  it('returns a null context when the desktop checkpoint bridge is absent', async () => {
    Reflect.deleteProperty(window, 'assistantCheckpoints');
    const repo = repositoryReturning(() => Promise.resolve([]));
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));
    await waitFor(() => {
      expect(result.current.checkpoints).toBeNull();
    });
  });

  it('returns a null context when no thread is selected', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    const repo = repositoryReturning(() => Promise.resolve([]));
    const { result } = renderHook(() => useEditCheckpoints(repo, null));
    await waitFor(() => {
      expect(result.current.checkpoints).toBeNull();
    });
  });

  it('maps repository entries by tool call id and exposes the full list', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    const repo = repositoryReturning(() =>
      Promise.resolve([
        makeEntry({ id: 'e1', toolCallId: 'call-a' }),
        makeEntry({ id: 'e2', toolCallId: 'call-b' }),
      ])
    );
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current.checkpoints?.entriesByToolCallId.size).toBe(2);
    });
    expect(result.current.checkpoints?.entriesByToolCallId.get('call-a')?.id).toBe('e1');
    expect(result.current.checkpoints?.entries.map((entry) => entry.id)).toEqual(['e1', 'e2']);
  });

  it('surfaces a checkpoint journaled during a live run when refetch fires (no thread switch)', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    let journaled: readonly AssistantEditCheckpointRecord[] = [];
    const listThreadCheckpoints = vi.fn(() => Promise.resolve(journaled));
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    // Thread open: nothing journaled yet, so the footer sees no entries.
    await waitFor(() => {
      expect(result.current.checkpoints).not.toBeNull();
    });
    expect(result.current.checkpoints?.entries).toHaveLength(0);

    // The run executes and journals an edit in main; a run-completion refetch —
    // NOT a thread switch or reload — must surface it.
    journaled = [makeEntry({ id: 'e1', toolCallId: 'call-a' })];
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.checkpoints?.entriesByToolCallId.get('call-a')?.id).toBe('e1');
  });

  it('reverts an entry through the bridge and refetches on success', async () => {
    const revertEntry = vi.fn().mockResolvedValue({
      entry: makeEntry({ id: 'e1', revertedAt: '2026-07-10T01:00:00.000Z', toolCallId: 'call-a' }),
      ok: true,
    } satisfies AssistantCheckpointRevertResult);
    stubBridge({ revertEntry, revertRun: vi.fn() });
    const listThreadCheckpoints = vi
      .fn()
      .mockResolvedValue([makeEntry({ id: 'e1', toolCallId: 'call-a' })]);
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current.checkpoints).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current.checkpoints?.revertEntry('e1', { force: true });
    });

    expect(revertEntry).toHaveBeenCalledWith('e1', { force: true });
    expect(listThreadCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('reverts a whole run through the bridge and refetches on success', async () => {
    const revertRun = vi.fn().mockResolvedValue({
      outcomes: [
        {
          entry: makeEntry({
            id: 'e1',
            revertedAt: '2026-07-10T01:00:00.000Z',
            toolCallId: 'call-a',
          }),
          ok: true,
        },
      ],
      runId: 'run-1',
    } satisfies AssistantCheckpointRevertRunResult);
    stubBridge({ revertEntry: vi.fn(), revertRun });
    const listThreadCheckpoints = vi
      .fn()
      .mockResolvedValue([makeEntry({ id: 'e1', toolCallId: 'call-a' })]);
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current.checkpoints).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current.checkpoints?.revertRun('run-1', { force: true });
    });

    expect(revertRun).toHaveBeenCalledWith('run-1', { force: true });
    expect(listThreadCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when a run revert reports a conflict', async () => {
    const revertRun = vi.fn().mockResolvedValue({
      outcomes: [{ code: 'conflict', id: 'e1', message: 'changed', ok: false }],
      runId: 'run-1',
    } satisfies AssistantCheckpointRevertRunResult);
    stubBridge({ revertEntry: vi.fn(), revertRun });
    const listThreadCheckpoints = vi
      .fn()
      .mockResolvedValue([makeEntry({ id: 'e1', toolCallId: 'call-a' })]);
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current.checkpoints).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current.checkpoints?.revertRun('run-1');
    });

    expect(revertRun).toHaveBeenCalledWith('run-1', undefined);
    expect(listThreadCheckpoints).not.toHaveBeenCalled();
  });

  it('refetches then rethrows when a run revert unexpectedly rejects (partial on-disk revert)', async () => {
    const revertRun = vi.fn().mockRejectedValue(new Error('EACCES'));
    stubBridge({ revertEntry: vi.fn(), revertRun });
    const listThreadCheckpoints = vi
      .fn()
      .mockResolvedValue([makeEntry({ id: 'e1', toolCallId: 'call-a' })]);
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current.checkpoints).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await expect(result.current.checkpoints?.revertRun('run-1')).rejects.toThrow('EACCES');
    });

    // A throw may have partially reverted on disk before aborting, so the list
    // must be re-read to reconcile the per-entry / turn controls.
    expect(listThreadCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale refetch resolving after a newer one (generation guard)', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    const deferred: Array<(entries: readonly AssistantEditCheckpointRecord[]) => void> = [];
    const listThreadCheckpoints = vi.fn(
      () =>
        new Promise<readonly AssistantEditCheckpointRecord[]>((resolve) => {
          deferred.push(resolve);
        })
    );
    const repo = repositoryReturning(listThreadCheckpoints);
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await act(async () => {
      const older = result.current.refetch();
      const newer = result.current.refetch();
      // Resolve the NEWEST call first, then every earlier (stale) one — including
      // the mount refetch still in flight.
      deferred.at(-1)?.([makeEntry({ id: 'fresh', toolCallId: 'call-fresh' })]);
      for (const resolve of deferred.slice(0, -1)) {
        resolve([makeEntry({ id: 'stale', toolCallId: 'call-stale' })]);
      }
      await Promise.all([older, newer]);
    });

    // The stale resolution must not clobber the fresher entries.
    expect(result.current.checkpoints?.entriesByToolCallId.get('call-fresh')?.id).toBe('fresh');
    expect(result.current.checkpoints?.entriesByToolCallId.has('call-stale')).toBe(false);
  });
});
