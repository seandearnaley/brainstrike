import type {
  AssistantCheckpointRevertRunResult,
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckpointTurnRevertControl,
  collectMutationToolCallIds,
} from '../assistant-ui-panel/checkpoint-turn-revert';
import type { EditCheckpointContextValue } from '../assistant-ui-panel/edit-checkpoint-context';
import {
  EditCheckpointProvider,
  selectRevertibleTurnEntries,
  useCheckpointTurnRevert,
} from '../assistant-ui-panel/edit-checkpoint-context';
import { TooltipProvider } from '../tooltip';

function makeEntry(
  overrides: Partial<AssistantEditCheckpointRecord> & { id: string; toolCallId: string }
): AssistantEditCheckpointRecord {
  return {
    afterExisted: true,
    afterHash: 'after',
    beforeExisted: true,
    beforeHash: 'before',
    beforeSize: 10,
    captureStatus: 'ok' as AssistantEditCheckpointCaptureStatus,
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

function entryMap(
  entries: readonly AssistantEditCheckpointRecord[]
): ReadonlyMap<string, AssistantEditCheckpointRecord> {
  const map = new Map<string, AssistantEditCheckpointRecord>();
  for (const entry of entries) {
    if (entry.toolCallId) {
      map.set(entry.toolCallId, entry);
    }
  }
  return map;
}

function wrap(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('collectMutationToolCallIds', () => {
  it('collects tool-call parts in order and ignores non-tool parts', () => {
    const parts = [
      { text: 'hi', type: 'text' },
      { toolCallId: 'call-a', toolName: 'brainstrike.writeWorkspaceFile', type: 'tool-call' },
      { text: 'thinking', type: 'reasoning' },
      { toolCallId: 'call-b', toolName: 'brainstrike.deleteWorkspaceFile', type: 'tool-call' },
      { toolName: 'no-id', type: 'tool-call' },
      null,
      'string-part',
    ];

    expect(collectMutationToolCallIds(parts)).toEqual(['call-a', 'call-b']);
  });
});

describe('selectRevertibleTurnEntries', () => {
  it('keeps only non-reverted, revertible-capture entries and dedupes run ids', () => {
    const entries = [
      makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' }),
      makeEntry({
        id: 'e2',
        revertedAt: '2026-07-10T01:00:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-b',
      }),
      makeEntry({
        captureStatus: 'skipped_binary',
        id: 'e3',
        runId: 'run-1',
        toolCallId: 'call-c',
      }),
      makeEntry({ id: 'e4', runId: 'run-2', toolCallId: 'call-d' }),
    ];

    const selection = selectRevertibleTurnEntries(
      ['call-a', 'call-b', 'call-c', 'call-d', 'call-missing'],
      entryMap(entries)
    );

    expect(selection.entries.map((entry) => entry.id)).toEqual(['e1', 'e4']);
    expect(selection.runIds).toEqual(['run-1', 'run-2']);
  });
});

function runResult(
  runId: string,
  outcomes: AssistantCheckpointRevertRunResult['outcomes']
): AssistantCheckpointRevertRunResult {
  return { outcomes, runId };
}

describe('useCheckpointTurnRevert', () => {
  function providerWith(value: EditCheckpointContextValue | null) {
    return ({ children }: { children: ReactNode }) => (
      <EditCheckpointProvider value={value}>{children}</EditCheckpointProvider>
    );
  }

  it('returns null when no provider is present', () => {
    const { result } = renderHook(() => useCheckpointTurnRevert(['call-a']), {
      wrapper: providerWith(null),
    });
    expect(result.current).toBeNull();
  });

  it('returns null when the turn has no revertible entries', () => {
    const value: EditCheckpointContextValue = {
      entriesByToolCallId: entryMap([
        makeEntry({ id: 'e1', revertedAt: '2026-07-10T01:00:00.000Z', toolCallId: 'call-a' }),
      ]),
      revertEntry: vi.fn(),
      revertRun: vi.fn(),
    };
    const { result } = renderHook(() => useCheckpointTurnRevert(['call-a']), {
      wrapper: providerWith(value),
    });
    expect(result.current).toBeNull();
  });

  it('reverts each distinct run id and reports the revertible count', async () => {
    const revertRun = vi
      .fn()
      .mockResolvedValue(
        runResult('run-1', [{ entry: makeEntry({ id: 'e1', toolCallId: 'call-a' }), ok: true }])
      );
    const value: EditCheckpointContextValue = {
      entriesByToolCallId: entryMap([
        makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' }),
        makeEntry({ id: 'e2', runId: 'run-2', toolCallId: 'call-b' }),
      ]),
      revertEntry: vi.fn(),
      revertRun,
    };
    const { result } = renderHook(() => useCheckpointTurnRevert(['call-a', 'call-b']), {
      wrapper: providerWith(value),
    });

    expect(result.current?.revertibleCount).toBe(2);

    await result.current?.revert({ force: true });
    expect(revertRun).toHaveBeenCalledWith('run-1', { force: true });
    expect(revertRun).toHaveBeenCalledWith('run-2', { force: true });
    expect(revertRun).toHaveBeenCalledTimes(2);
  });
});

describe('CheckpointTurnRevertControl', () => {
  it('confirms before reverting and calls onRevert without force', async () => {
    const user = userEvent.setup();
    const onRevert = vi
      .fn()
      .mockResolvedValue([
        runResult('run-1', [{ entry: makeEntry({ id: 'e1', toolCallId: 'call-a' }), ok: true }]),
      ]);

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={2} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-confirm'));

    expect(onRevert).toHaveBeenCalledWith(false);
  });

  it('surfaces a conflict and reverts anyway with force', async () => {
    const user = userEvent.setup();
    const onRevert = vi
      .fn()
      .mockResolvedValueOnce([
        runResult('run-1', [{ code: 'conflict', id: 'e1', message: 'changed', ok: false }]),
      ])
      .mockResolvedValueOnce([
        runResult('run-1', [{ entry: makeEntry({ id: 'e1', toolCallId: 'call-a' }), ok: true }]),
      ]);

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={1} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-confirm'));

    const revertAnyway = await screen.findByTestId('checkpoint-turn-revert-anyway');
    await user.click(revertAnyway);

    await waitFor(() => {
      expect(onRevert).toHaveBeenNthCalledWith(1, false);
      expect(onRevert).toHaveBeenNthCalledWith(2, true);
    });
  });

  it('cancels the confirm without reverting', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn();

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={3} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-cancel'));

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByTestId('checkpoint-turn-revert')).toBeInTheDocument();
  });
});
