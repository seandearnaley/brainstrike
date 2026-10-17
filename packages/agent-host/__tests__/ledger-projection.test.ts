import approvedRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  foldLatestRun,
  HostLedgerProjection,
  mergeRootUsage,
  ThreadLedgerFold,
} from '../src/ledger-projection.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';

// Two recorded runs, each with an approved tool call and two model steps. The
// runtime shape commits a time on every row and a provider::model run model.
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const BASE = Date.parse('2026-10-08T12:00:00Z');
const rows: HostLogRow[] = richRecording.map((raw) => {
  const row = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(raw);
  const event = row.event.type === 'run.started' ? { ...row.event, modelId: MODEL } : row.event;
  return { ...row, event, ts: BASE + row.seq * 1000 };
});
const threadId = rows[0]?.threadId ?? '';
const started = rows.filter((row) => row.event.type === 'run.started');
const [first] = started;
if (first?.event.type !== 'run.started') {
  throw new Error('The recording has no run');
}
const { runId } = first.event;
function folded(log: readonly HostLogRow[]) {
  const fold = new ThreadLedgerFold();
  for (const row of log) {
    fold.apply(row);
  }
  return fold.read();
}
/** The recording, with `events` committed right after the first run starts. */
const insertAfterStart = (...events: Record<string, unknown>[]): HostLogRow[] => {
  const at = rows.indexOf(first) + 1;
  return [
    ...rows.slice(0, at),
    ...events.map((event) => ({ event, seq: 0, threadId })),
    ...rows.slice(at),
  ].map((row, index) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
      ...row,
      seq: index + 1,
      ts: BASE + (index + 1) * 1000,
    })
  );
};
/** The recording with its first run's start replaced by `event`'s fields. */
const startedWith = (event: Record<string, unknown>): HostLogRow[] => {
  const replaced = Schema.decodeUnknownSync(HostLogRowSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({ ...first, event: { ...first.event, ...event } });
  return rows.map((row) => (row === first ? replaced : row));
};
test('a committed log folds into ledger runs and per-call usage', () => {
  const { runs, usage } = folded(rows);
  expect(runs).toHaveLength(2);
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  expect(runs.find((run) => run.runId === runId)).toEqual({
    completedAt: finished?.ts,
    durationMs: (finished?.ts ?? 0) - (first.ts ?? 0),
    editCount: 0,
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
    estimatedInputTokens: 2,
    estimatedOutputTokens: 50,
    failedToolCallCount: 0,
    inputTokens: 2,
    model: 'anthropic/claude-sonnet-4.6',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: 50,
    provider: 'openrouter',
    revertedEditCount: 0,
    runId,
    startedAt: first.ts,
    status: 'completed',
    threadId,
    toolCallCount: 1,
  });
  // One usage record per committed model step, at its commit time.
  expect(usage).toHaveLength(4);
  expect(usage[0]).toEqual({
    at: rows.find((row) => row.event.type === 'model.step')?.ts,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 1,
    model: 'anthropic/claude-sonnet-4.6',
    outputTokens: 25,
    provider: 'openrouter',
  });
});
test("a compaction summarizer's side call counts within its run and as a provider call", () => {
  // Core commits it before the run's first request, in memory.usage's shape:
  // the run's own model and the SDK totalUsage as reported.
  const { runs, usage } = folded(
    insertAfterStart({
      compactedRunIds: [runId],
      kind: 'agentic',
      modelId: MODEL,
      reason: 'pre-request',
      runId,
      summary: 'State: earlier turns were summarized.',
      type: 'context.compacted',
      usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
    })
  );
  expect(runs.find((run) => run.runId === runId)).toMatchObject({
    inputTokens: 44,
    outputTokens: 59,
  });
  expect(usage).toHaveLength(5);
  expect(usage[0]).toEqual({
    at: BASE + (rows.indexOf(first) + 2) * 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 42,
    model: 'anthropic/claude-sonnet-4.6',
    outputTokens: 9,
    provider: 'openrouter',
  });
});
test('a run still open folds as running', () => {
  const second = started[1];
  if (!second) {
    throw new Error('The recording has no second run');
  }
  const { runs } = folded(rows.filter((row) => row.seq <= second.seq));
  expect(runs.find((run) => run.startedAt === second.ts)).toMatchObject({
    completedAt: null,
    durationMs: null,
    status: 'running',
  });
});
describe("a thread's per-model subtotals for the meter's thread total", () => {
  test('chat steps sum per model; the subtotals read stable until a costed call', () => {
    const fold = new ThreadLedgerFold();
    expect(fold.perModel()).toEqual([]);
    for (const row of rows) {
      fold.apply(row);
    }
    // Four recorded steps of 1 input / 25 output under the run's model.
    const perModel = fold.perModel();
    expect(perModel).toEqual([
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedInputTokens: 4,
        estimatedOutputTokens: 100,
        inputTokens: 4,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 100,
        provider: 'openrouter',
        runKind: 'chat',
      },
    ]);
    // A streamed row is no costed call.
    const chunk = rows.find((row) => row.event.type === 'stream.chunk');
    if (!chunk) {
      throw new Error('The recording streamed nothing');
    }
    fold.apply({ ...chunk, seq: fold.seq + 1 });
    expect(fold.perModel()).toBe(perModel);
    expect(fold.read().perModel).toBe(perModel);
  });
  test('a compaction side call is its own source under the run model', () => {
    const { perModel } = folded(
      insertAfterStart({
        compactedRunIds: [runId],
        kind: 'agentic',
        modelId: MODEL,
        reason: 'pre-request',
        runId,
        summary: 'State: earlier turns were summarized.',
        type: 'context.compacted',
        usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
      })
    );
    expect(perModel).toMatchObject([
      { inputTokens: 42, outputTokens: 9, runKind: 'compaction-summary' },
      { inputTokens: 4, outputTokens: 100, runKind: 'chat' },
    ]);
  });
  test('observer usage under a catalog model is an observation source; any other id is not costed', () => {
    const observation = {
      kind: 'observation',
      modelId: 'openrouter::google/gemini-2.5-flash',
      runId,
      type: 'memory.usage',
      usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
    };
    // The memory provider reports the SDK model's own id, which names no provider.
    const unattributed = { ...observation, kind: 'reflection', modelId: 'gemini-2.5-flash' };
    const { perModel, runs } = folded(insertAfterStart(observation, unattributed));
    expect(perModel).toMatchObject([
      {
        inputTokens: 300,
        model: 'google/gemini-2.5-flash',
        outputTokens: 40,
        provider: 'openrouter',
        runKind: 'om-observation',
      },
      { runKind: 'chat' },
    ]);
    // Both calls count within their run.
    expect(runs.find((run) => run.runId === runId)).toMatchObject({
      inputTokens: 602,
      outputTokens: 130,
    });
  });
});
describe("the Task Ledger's and cost views' share of a host run", () => {
  const hash = (digit: string): string => digit.repeat(64);
  const edit = (entryId: string, path: string) => ({
    after: { existed: true, hash: hash('b'), size: 12 },
    baselines: [{ kind: 'absent', path }],
    before: { existed: false, hash: null, size: null },
    entryId,
    op: 'write',
    path,
    rootId: 'root-a',
    rootPath: '/tmp/workspace-a',
    runId,
    toolCallId: `call-${entryId}`,
    toolId: 'brainstrike.writeFile',
    type: 'workspace.edit.recorded',
  });
  test('its committed edits and reverts count in its ledger row, each revert once', () => {
    const revert = (commandId: string) => ({
      commandId,
      outcomes: [
        { entryId: 'edit-1', status: 'reverted' },
        { entryId: 'edit-2', reason: 'The file changed since the edit.', status: 'conflict' },
      ],
      runId,
      type: 'workspace.edit.reverted',
    });
    const { runs } = folded(
      insertAfterStart(
        edit('edit-1', 'notes.txt'),
        edit('edit-2', 'plan.md'),
        revert('revert-1'),
        revert('revert-2')
      )
    );
    expect(runs.find((run) => run.runId === runId)).toMatchObject({
      editCount: 2,
      revertedEditCount: 1,
    });
  });
  test("its provider calls count toward its bound root's cost; an unbound run's are unattributed", () => {
    const { rootUsage } = folded(
      startedWith({
        snapshot: {
          configuration: {},
          maxSteps: 12,
          toolIdentities: {},
          workspaceBinding: { operatingRootDisplayName: 'Workspace A', operatingRootId: 'root-a' },
        },
      })
    );
    // Each run commits two steps of 1 input / 25 output; unattributed first, as the SQL orders.
    expect(mergeRootUsage([rootUsage])).toEqual([
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedInputTokens: 2,
        estimatedOutputTokens: 50,
        inputTokens: 2,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 50,
        provider: 'openrouter',
        rootDisplayName: null,
        rootId: null,
      },
      {
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedInputTokens: 2,
        estimatedOutputTokens: 50,
        inputTokens: 2,
        model: 'anthropic/claude-sonnet-4.6',
        outputTokens: 50,
        provider: 'openrouter',
        rootDisplayName: 'Workspace A',
        rootId: 'root-a',
      },
    ]);
  });
  test('threads sum per (root, provider, model) in the cross-root order', () => {
    const { rootUsage } = folded(rows);
    expect(mergeRootUsage([rootUsage, rootUsage])).toMatchObject([
      { inputTokens: 8, outputTokens: 200, rootId: null },
    ]);
  });
  test("an unbound run's provider calls count toward the root focused at its Send", () => {
    // The desktop's durable run configuration commits the Send intent, focused root included.
    const { rootUsage } = folded(
      startedWith({
        snapshot: {
          configuration: { intent: { selectionFolderId: 'root-b' } },
          maxSteps: 12,
          toolIdentities: {},
        },
      })
    );
    // The roots table names it; the run's log carries only its id.
    expect(
      mergeRootUsage([rootUsage]).map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', null],
    ]);
  });
  test("an observer call costs under the catalog id it commits, not its run's resolved target", () => {
    const costedSources = (modelId: string) => {
      const at = rows.indexOf(first);
      // The run still records the observer target its admission resolved.
      const observing = Schema.decodeUnknownSync(HostLogRowSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        ...first,
        event: {
          ...first.event,
          snapshot: {
            configuration: {
              memoryResolution: {
                observationalMemory: 'resolved',
                observerTarget: 'openai/gpt-4.1-mini',
              },
            },
            maxSteps: 12,
            toolIdentities: {},
          },
        },
      });
      const observation = {
        kind: 'observation',
        modelId,
        runId,
        type: 'memory.usage',
        usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      };
      return folded(
        [
          ...rows.slice(0, at),
          observing,
          { event: observation, seq: 0, threadId },
          ...rows.slice(at + 1),
        ].map((row, index) =>
          Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
            ...row,
            seq: index + 1,
            ts: BASE + (index + 1) * 1000,
          })
        )
      ).perModel.map(({ model, provider, runKind }) => [provider, model, runKind]);
    };
    // Core commits the observer's catalog id (BST-1929).
    expect(costedSources('openai::gpt-4.1-mini')).toEqual([
      ['openai', 'gpt-4.1-mini', 'om-observation'],
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
    // An SDK model id, as rows committed before BST-1929 carry, names no
    // provider: it is not costed, though it matches the run's resolved target.
    expect(costedSources('gpt-4.1-mini')).toEqual([
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
    // The built-in local observer bills nothing.
    expect(costedSources('local::gemma-4-e2b-it')).toEqual([
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
  });
});
describe("a thread's latest root run", () => {
  const approved = approvedRecording.map((row) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
  );
  const indexOf = (log: readonly HostLogRow[], type: string): number => {
    const index = log.findIndex((row) => row.event.type === type);
    if (index < 0) {
      throw new Error(`The recording has no ${type}`);
    }
    return index;
  };
  const latest = (log: readonly HostLogRow[]) => log.reduce(foldLatestRun, undefined)?.run;
  /** The recording's last terminal row with `outcome` and a commit time, as Core commits it. */
  const finishedAs = (
    outcome: 'completed' | 'failed' | 'interrupted' | 'stopped',
    log: readonly HostLogRow[] = approved
  ): HostLogRow[] => {
    const last = log.findLastIndex((row) => row.event.type === 'run.finished');
    return log.map((row, index) =>
      index === last && row.event.type === 'run.finished'
        ? { ...row, event: { ...row.event, outcome }, ts: BASE }
        : row
    );
  };
  test('runs until its own finish; a recording without commit times invents no finish time', () => {
    // The real recording, as a log whose rows carry no commit times.
    const untimed = approved.map(({ ts: _ts, ...row }) => row);
    const open = untimed.slice(0, indexOf(untimed, 'run.finished'));
    expect(latest(open)).toEqual({
      completedAt: null,
      needsInput: false,
      seq: open.findLast((row) => row.event.type === 'interaction.responded')?.seq,
      status: 'running',
    });
    expect(latest(untimed)).toEqual({
      completedAt: null,
      needsInput: false,
      seq: untimed[indexOf(untimed, 'run.finished')]?.seq,
      status: 'completed',
    });
  });
  test('the latest of several runs decides; its finish time is the committed row time', () => {
    const second = rows.findLastIndex((row) => row.event.type === 'run.started');
    expect(latest(rows.slice(0, second + 1))?.status).toBe('running');
    expect(latest(finishedAs('failed', rows))).toMatchObject({
      completedAt: BASE,
      needsInput: false,
      status: 'failed',
    });
  });
  test('outcomes read as the legacy run statuses: Stop is cancelled, an interruption failed', () => {
    expect(latest(finishedAs('stopped'))?.status).toBe('cancelled');
    expect(latest(finishedAs('interrupted'))?.status).toBe('failed');
  });
  test('a run waiting on its user needs input until the committed response', () => {
    expect(latest(approved.slice(0, indexOf(approved, 'interaction.requested') + 1))).toMatchObject(
      { needsInput: true, status: 'running' }
    );
    expect(
      latest(approved.slice(0, indexOf(approved, 'interaction.responded') + 1))?.needsInput
    ).toBe(false);
  });
});
describe("Core's projection of every thread", () => {
  test('lists each thread it folded until the thread is forgotten', () => {
    const projection = new HostLedgerProjection();
    for (const row of rows) {
      projection.apply(row);
    }
    expect(projection.read()).toEqual({ threads: [{ threadId, ...folded(rows) }] });
    expect(projection.readLatestRun(threadId)).toEqual(rows.reduce(foldLatestRun, undefined)?.run);
    projection.forget(threadId);
    expect(projection.read()).toEqual({ threads: [] });
    expect(projection.readLatestRun(threadId)).toBeUndefined();
  });
  test('a row its ledger cannot fold fails every ledger read, naming the thread and row', () => {
    const projection = new HostLedgerProjection();
    const step = rows.find((row) => row.event.type === 'model.step');
    if (step?.event.type !== 'model.step') {
      throw new Error('The recording has no model step');
    }
    // A usage the committed event admits (any JSON) but no token count reads.
    const unreadable = { ...step, event: { ...step.event, usage: { inputTokens: -1 } } };
    for (const row of rows.map((row) => (row === step ? unreadable : row))) {
      expect(() => projection.apply(row)).not.toThrow();
    }
    expect(() => projection.read()).toThrow(`Thread ${threadId} row ${step.seq} cannot be costed`);
    // The thread's run state still folds.
    expect(projection.readLatestRun(threadId)).toEqual(rows.reduce(foldLatestRun, undefined)?.run);
  });
});
