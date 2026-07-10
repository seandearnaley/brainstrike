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
  it('returns null when the desktop checkpoint bridge is absent', async () => {
    Reflect.deleteProperty(window, 'assistantCheckpoints');
    const repo = repositoryReturning(() => Promise.resolve([]));
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('returns null when no thread is selected', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    const repo = repositoryReturning(() => Promise.resolve([]));
    const { result } = renderHook(() => useEditCheckpoints(repo, null));
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('maps repository entries by tool call id', async () => {
    stubBridge({ revertEntry: vi.fn(), revertRun: vi.fn() });
    const repo = repositoryReturning(() =>
      Promise.resolve([
        makeEntry({ id: 'e1', toolCallId: 'call-a' }),
        makeEntry({ id: 'e2', toolCallId: 'call-b' }),
      ])
    );
    const { result } = renderHook(() => useEditCheckpoints(repo, 'thread-1'));

    await waitFor(() => {
      expect(result.current?.entriesByToolCallId.size).toBe(2);
    });
    expect(result.current?.entriesByToolCallId.get('call-a')?.id).toBe('e1');
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
      expect(result.current).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current?.revertEntry('e1', { force: true });
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
      expect(result.current).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current?.revertRun('run-1', { force: true });
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
      expect(result.current).not.toBeNull();
    });
    listThreadCheckpoints.mockClear();

    await act(async () => {
      await result.current?.revertRun('run-1');
    });

    expect(revertRun).toHaveBeenCalledWith('run-1', undefined);
    expect(listThreadCheckpoints).not.toHaveBeenCalled();
  });
});
