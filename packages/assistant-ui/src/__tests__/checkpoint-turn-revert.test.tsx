import type {
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailability,
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointTurnRevertControl, collectMutationToolCallIds } from '../checkpoint-turn-revert';
import type { EditCheckpointContextValue } from '../edit-checkpoint-context';
import {
  EditCheckpointProvider,
  selectTurnRevertScope,
  useCheckpointTurnRevert,
} from '../edit-checkpoint-context';

function makeEntry(
  overrides: Partial<AssistantEditCheckpointRecord> & { id: string; toolCallId: string | null }
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

/** Snapshot availability marking every entry restorable (the common case). */
function allRestorable(
  entries: readonly AssistantEditCheckpointRecord[]
): ReadonlyMap<string, AssistantCheckpointUndoAvailability> {
  return new Map(entries.map((entry) => [entry.id, { restorable: true } as const]));
}

function contextValue(
  entries: readonly AssistantEditCheckpointRecord[],
  overrides: Partial<EditCheckpointContextValue> = {}
): EditCheckpointContextValue {
  const entriesByToolCallId = new Map<string, AssistantEditCheckpointRecord>();
  for (const entry of entries) {
    if (entry.toolCallId) {
      entriesByToolCallId.set(entry.toolCallId, entry);
    }
  }
  return {
    availabilityById: allRestorable(entries),
    entries,
    entriesByToolCallId,
    revertEntry: vi.fn(),
    revertRefusal: null,
    revertRun: vi.fn(),
    ...overrides,
  };
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

// BST-1115 W5 T4 — the inherited T3 follow-up, PINNED rather than asserted.
//
// A files-mode rewind journals an after-capture row per reverted file so redo
// is possible. Those rows live in the same table `listThreadCheckpoints` reads,
// so they reach this selector too. They must NOT produce a "Revert all edits"
// footer: they carry `toolCallId: null` (nothing rendered them as a tool call)
// and their `runId` is the REVERT batch id, which no message owns. That makes
// the exclusion structural, so no `REWIND_REVERT_TOOL_NAME` filter is needed —
// and this is the test that would fail if that ever stopped being true.
describe('selectTurnRevertScope with rewind revert-capture rows', () => {
  const revertRows = [
    makeEntry({
      id: 'revert-1',
      runId: 'revert-batch-1',
      toolCallId: null,
      toolName: 'brainstrike.rewindRevert',
    }),
    makeEntry({
      id: 'revert-2',
      path: 'src/other.ts',
      runId: 'revert-batch-1',
      toolCallId: null,
      toolName: 'brainstrike.rewindRevert',
    }),
  ];

  it('produces no turn footer of their own', () => {
    expect(selectTurnRevertScope(['call-a'], revertRows, allRestorable(revertRows))).toBeNull();
  });

  it('does not inflate a real turn’s revertible count', () => {
    const rows = [makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' }), ...revertRows];
    const scope = selectTurnRevertScope(['call-a'], rows, allRestorable(rows));

    expect(scope).toEqual({ revertibleCount: 1, runIds: ['run-1'], unavailableReason: null });
  });
});

describe('selectTurnRevertScope', () => {
  it('counts the whole run even when this message shows only its last edit (split run)', () => {
    const entries = [
      makeEntry({
        id: 'e1',
        occurredAt: '2026-07-10T00:00:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-a',
      }),
      makeEntry({
        id: 'e2',
        occurredAt: '2026-07-10T00:01:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-b',
      }),
    ];

    // The message that renders the run's LAST edit owns the footer and its count
    // is the whole run's revert scope (2), not just this message's one edit.
    const scope = selectTurnRevertScope(['call-b'], entries, allRestorable(entries));
    expect(scope).toEqual({ revertibleCount: 2, runIds: ['run-1'], unavailableReason: null });
  });

  it("renders no footer on a message that is not the run's last leg", () => {
    const entries = [
      makeEntry({
        id: 'e1',
        occurredAt: '2026-07-10T00:00:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-a',
      }),
      makeEntry({
        id: 'e2',
        occurredAt: '2026-07-10T00:01:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-b',
      }),
    ];

    // The earlier leg (call-a) must NOT show a footer — otherwise a split run
    // would render duplicate footers, each with a dishonest count.
    expect(selectTurnRevertScope(['call-a'], entries, allRestorable(entries))).toBeNull();
  });

  it('excludes reverted and unrevertible-capture entries from the count', () => {
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
    ];

    const scope = selectTurnRevertScope(
      ['call-a', 'call-b', 'call-c'],
      entries,
      allRestorable(entries)
    );
    expect(scope).toEqual({ revertibleCount: 1, runIds: ['run-1'], unavailableReason: null });
  });

  it("counts a run's toolCallId:null entries even though they never render a footer", () => {
    const entries = [
      makeEntry({
        id: 'e1',
        occurredAt: '2026-07-10T00:00:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-a',
      }),
      makeEntry({
        id: 'e2',
        occurredAt: '2026-07-10T00:01:00.000Z',
        runId: 'run-1',
        toolCallId: null,
      }),
    ];

    // revertRun(run-1) reverts BOTH entries; the count must reflect that, so the
    // user never consents to fewer files than actually change.
    const scope = selectTurnRevertScope(['call-a'], entries, allRestorable(entries));
    expect(scope).toEqual({ revertibleCount: 2, runIds: ['run-1'], unavailableReason: null });
  });

  it('orders multiple runs of a merged message newest-applied first', () => {
    const entries = [
      makeEntry({
        id: 'e1',
        occurredAt: '2026-07-10T00:00:00.000Z',
        runId: 'run-1',
        toolCallId: 'call-a',
      }),
      makeEntry({
        id: 'e2',
        occurredAt: '2026-07-10T00:05:00.000Z',
        runId: 'run-2',
        toolCallId: 'call-b',
      }),
    ];

    const scope = selectTurnRevertScope(['call-a', 'call-b'], entries, allRestorable(entries));
    expect(scope).toEqual({
      revertibleCount: 2,
      runIds: ['run-2', 'run-1'],
      unavailableReason: null,
    });
  });
});

describe('selectTurnRevertScope with snapshot availability (BST-1164 T4)', () => {
  it('excludes unavailable entries from the count but keeps the run owned', () => {
    const entries = [
      makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' }),
      makeEntry({ id: 'e2', path: 'src/pre.ts', runId: 'run-1', toolCallId: 'call-b' }),
    ];
    const availability = new Map<string, AssistantCheckpointUndoAvailability>([
      ['e1', { restorable: true }],
      [
        'e2',
        {
          reason: 'This edit predates workspace snapshots, so it cannot be restored.',
          restorable: false,
        },
      ],
    ]);
    const scope = selectTurnRevertScope(['call-a', 'call-b'], entries, availability);
    expect(scope).toEqual({ revertibleCount: 1, runIds: ['run-1'], unavailableReason: null });
  });

  it('reports the unavailable reason (and no run ids) when NOTHING is restorable', () => {
    const entries = [makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' })];
    const availability = new Map<string, AssistantCheckpointUndoAvailability>([
      [
        'e1',
        {
          reason: 'This edit predates workspace snapshots, so it cannot be restored.',
          restorable: false,
        },
      ],
    ]);
    const scope = selectTurnRevertScope(['call-a'], entries, availability);
    expect(scope).toEqual({
      revertibleCount: 0,
      runIds: [],
      unavailableReason: 'This edit predates workspace snapshots, so it cannot be restored.',
    });
  });

  it('treats an entry MISSING from the availability map as unavailable (fail-safe, never enabled)', () => {
    const entries = [makeEntry({ id: 'e1', runId: 'run-1', toolCallId: 'call-a' })];
    const scope = selectTurnRevertScope(['call-a'], entries, new Map());
    expect(scope?.revertibleCount).toBe(0);
    expect(scope?.unavailableReason).toContain('could not be determined');
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
    const value = contextValue([
      makeEntry({ id: 'e1', revertedAt: '2026-07-10T01:00:00.000Z', toolCallId: 'call-a' }),
    ]);
    const { result } = renderHook(() => useCheckpointTurnRevert(['call-a']), {
      wrapper: providerWith(value),
    });
    expect(result.current).toBeNull();
  });

  it('reverts each distinct run sequentially (newest first) and reports the run-scoped count', async () => {
    const order: string[] = [];
    // Gate the FIRST (newest) run's promise so it stays pending. A sequential
    // loop MUST await it before invoking the second run; `Promise.all(map(...))`
    // would call both synchronously. Asserting the second run has NOT fired while
    // the first is unresolved is what actually pins sequentiality — a mutation
    // back to a parallel implementation fails this, not just the final order.
    let resolveFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const revertRun = vi.fn((runId: string) => {
      order.push(runId);
      const result = runResult(runId, [
        { entry: makeEntry({ id: 'e1', toolCallId: 'call-a' }), ok: true },
      ]);
      // run-2 is the newest run (reverted first) — hold its promise open.
      return runId === 'run-2' ? firstGate.then(() => result) : Promise.resolve(result);
    });
    const value = contextValue(
      [
        makeEntry({
          id: 'e1',
          occurredAt: '2026-07-10T00:00:00.000Z',
          runId: 'run-1',
          toolCallId: 'call-a',
        }),
        makeEntry({
          id: 'e2',
          occurredAt: '2026-07-10T00:05:00.000Z',
          runId: 'run-2',
          toolCallId: 'call-b',
        }),
      ],
      { revertRun }
    );
    const { result } = renderHook(() => useCheckpointTurnRevert(['call-a', 'call-b']), {
      wrapper: providerWith(value),
    });

    expect(result.current?.revertibleCount).toBe(2);

    const revertPromise = result.current?.revert({ force: true });
    // Flush microtasks: a sequential loop is now parked awaiting run-2's gate, so
    // run-1 must NOT have been called yet. A parallel impl would already show both.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['run-2']);
    expect(revertRun).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await revertPromise;

    expect(revertRun).toHaveBeenCalledWith('run-1', { force: true });
    expect(revertRun).toHaveBeenCalledWith('run-2', { force: true });
    expect(revertRun).toHaveBeenCalledTimes(2);
    // Newest run first so cross-run inverse writes land in reverse order.
    expect(order).toEqual(['run-2', 'run-1']);
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

  it('surfaces a visible failure and stays actionable when the revert rejects', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn().mockRejectedValue(new Error('disk full'));

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={2} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-confirm'));

    // Never left stuck disabled in 'reverting' — a visible error + a retry.
    const error = await screen.findByTestId('checkpoint-turn-revert-error');
    expect(error).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-turn-revert-retry')).toBeEnabled();
  });

  it('shows the refusal a rejected revert carries, not a generic failure', async () => {
    const user = userEvent.setup();
    const refusal = 'Checkpoint revert is refused while the thread has an active run';
    const onRevert = vi.fn().mockRejectedValue(new Error(refusal));

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={2} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-confirm'));

    expect(await screen.findByTestId('checkpoint-turn-revert-error')).toHaveTextContent(refusal);
  });

  it('disables Revert all while reverts are refused', () => {
    wrap(
      <CheckpointTurnRevertControl
        onRevert={vi.fn()}
        refusal="Edits can be reverted once the current run finishes."
        revertibleCount={2}
      />
    );
    expect(screen.getByTestId('checkpoint-turn-revert')).toBeDisabled();
  });

  it('surfaces the reason when a revert reverts nothing (no conflict to force)', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn().mockResolvedValue([
      runResult('run-1', [
        {
          code: 'not_revertible',
          id: 'e1',
          message: 'its workspace folder is no longer connected. Re-open the folder and try again.',
          ok: false,
        },
      ]),
    ]);

    wrap(<CheckpointTurnRevertControl onRevert={onRevert} revertibleCount={1} />);

    await user.click(screen.getByTestId('checkpoint-turn-revert'));
    await user.click(screen.getByTestId('checkpoint-turn-revert-confirm'));

    const error = await screen.findByTestId('checkpoint-turn-revert-error');
    expect(error).toHaveTextContent('workspace folder is no longer connected');
  });
});
