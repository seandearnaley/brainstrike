import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { describe, expect, test } from 'vitest';
import { HostThreadLedger } from '../renderer/host-thread-ledger';

// Two recorded runs, each with an approved tool call and two model steps. The
// runtime shape commits a time on every row and a provider::model run model.
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const BASE = Date.parse('2026-10-08T12:00:00Z');
const rows: HostLogRow[] = richRecording.map((raw) => {
  const row = HostLogRowSchema.parse(raw);
  const event = row.event.type === 'run.started' ? { ...row.event, modelId: MODEL } : row.event;
  return { ...row, event, ts: BASE + row.seq * 1000 };
});
const threadId = rows[0]?.threadId ?? '';
const started = rows.filter((row) => row.event.type === 'run.started');

test('a committed log reads as ledger runs and per-call usage', () => {
  const ledger = new HostThreadLedger();
  ledger.accept(threadId, rows);
  const { runs, usage } = ledger.getSnapshot();
  expect(runs).toHaveLength(2);
  const [first] = started;
  if (first?.event.type !== 'run.started') {
    throw new Error('The recording has no run');
  }
  const { runId } = first.event;
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  expect(runs.find((run) => run.runId === runId)).toEqual({
    completedAt: new Date(finished?.ts ?? 0),
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
    startedAt: new Date(first.ts ?? 0),
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
  const [first] = started;
  if (first?.event.type !== 'run.started') {
    throw new Error('The recording has no run');
  }
  const { runId } = first.event;
  // Core commits it before the run's first request, in memory.usage's shape:
  // the run's own model and the SDK totalUsage as reported.
  const compaction = {
    compactedRunIds: [runId],
    kind: 'agentic',
    modelId: MODEL,
    reason: 'pre-request',
    runId,
    summary: 'State: earlier turns were summarized.',
    type: 'context.compacted',
    usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
  };
  const at = rows.indexOf(first) + 1;
  const withCompaction = [
    ...rows.slice(0, at),
    { event: compaction, seq: 0, threadId },
    ...rows.slice(at),
  ].map((row, index) =>
    HostLogRowSchema.parse({ ...row, seq: index + 1, ts: BASE + (index + 1) * 1000 })
  );
  const ledger = new HostThreadLedger();
  ledger.accept(threadId, withCompaction);
  const { runs, usage } = ledger.getSnapshot();
  expect(runs.find((run) => run.runId === runId)).toMatchObject({
    inputTokens: 44,
    outputTokens: 59,
  });
  expect(usage).toHaveLength(5);
  expect(usage[0]).toEqual({
    at: BASE + (at + 1) * 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 42,
    model: 'anthropic/claude-sonnet-4.6',
    outputTokens: 9,
    provider: 'openrouter',
  });
});

test('a running run lists as running; deleting the thread drops it', () => {
  const ledger = new HostThreadLedger();
  const second = started[1];
  if (!second) {
    throw new Error('The recording has no second run');
  }
  ledger.accept(
    threadId,
    rows.filter((row) => row.seq <= second.seq)
  );
  expect(
    ledger.getSnapshot().runs.find((run) => run.startedAt.getTime() === second.ts)
  ).toMatchObject({ completedAt: null, durationMs: null, status: 'running' });
  ledger.delete(threadId);
  expect(ledger.getSnapshot()).toEqual({ rootUsage: [], runs: [], usage: [] });
});

describe("a thread's committed usage for the meter's thread total", () => {
  const [first] = started;
  if (first?.event.type !== 'run.started') {
    throw new Error('The recording has no run');
  }
  const { runId } = first.event;
  const insertAfterStart = (...events: Record<string, unknown>[]): HostLogRow[] => {
    const at = rows.indexOf(first) + 1;
    return [
      ...rows.slice(0, at),
      ...events.map((event) => ({ event, seq: 0, threadId })),
      ...rows.slice(at),
    ].map((row, index) =>
      HostLogRowSchema.parse({ ...row, seq: index + 1, ts: BASE + (index + 1) * 1000 })
    );
  };

  test('chat steps sum per model; a fold reads stable until the log advances', () => {
    const ledger = new HostThreadLedger();
    expect(ledger.getThreadUsage(threadId)).toBeUndefined();
    ledger.accept(threadId, rows);
    const usage = ledger.getThreadUsage(threadId);
    // Four recorded steps of 1 input / 25 output under the run's model.
    expect(usage).toEqual({
      perModel: [
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
      ],
      totalInputTokens: 4,
      totalOutputTokens: 100,
    });
    ledger.accept('another-thread', []);
    expect(ledger.getThreadUsage(threadId)).toBe(usage);
    ledger.delete(threadId);
    expect(ledger.getThreadUsage(threadId)).toBeUndefined();
  });

  test('a thread with no provider call yet reads as an empty total', () => {
    const ledger = new HostThreadLedger();
    ledger.accept(threadId, rows.slice(0, rows.indexOf(first) + 1));
    expect(ledger.getThreadUsage(threadId)).toEqual({
      perModel: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  });

  test('a compaction side call is its own source under the run model', () => {
    const ledger = new HostThreadLedger();
    ledger.accept(
      threadId,
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
    expect(ledger.getThreadUsage(threadId)).toMatchObject({
      perModel: [
        { inputTokens: 42, outputTokens: 9, runKind: 'compaction-summary' },
        { inputTokens: 4, outputTokens: 100, runKind: 'chat' },
      ],
      totalInputTokens: 46,
      totalOutputTokens: 109,
    });
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
    const ledger = new HostThreadLedger();
    ledger.accept(threadId, insertAfterStart(observation, unattributed));
    expect(ledger.getThreadUsage(threadId)).toMatchObject({
      perModel: [
        {
          inputTokens: 300,
          model: 'google/gemini-2.5-flash',
          outputTokens: 40,
          provider: 'openrouter',
          runKind: 'om-observation',
        },
        { runKind: 'chat' },
      ],
      totalInputTokens: 304,
      totalOutputTokens: 140,
    });
  });
});

describe("the Task Ledger's and cost views' share of a host run", () => {
  const [first] = started;
  if (first?.event.type !== 'run.started') {
    throw new Error('The recording has no run');
  }
  const { runId } = first.event;
  /** The recording, with `events` committed right after the first run starts. */
  const withRows = (...events: Record<string, unknown>[]): HostLogRow[] => {
    const at = rows.indexOf(first) + 1;
    return [
      ...rows.slice(0, at),
      ...events.map((event) => ({ event, seq: 0, threadId })),
      ...rows.slice(at),
    ].map((row, index) =>
      HostLogRowSchema.parse({ ...row, seq: index + 1, ts: BASE + (index + 1) * 1000 })
    );
  };
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
    const ledger = new HostThreadLedger();
    ledger.accept(
      threadId,
      withRows(
        edit('edit-1', 'notes.txt'),
        edit('edit-2', 'plan.md'),
        revert('revert-1'),
        revert('revert-2')
      )
    );
    expect(ledger.getSnapshot().runs.find((run) => run.runId === runId)).toMatchObject({
      editCount: 2,
      revertedEditCount: 1,
    });
  });

  test("its provider calls count toward its bound root's cost; an unbound run's are unattributed", () => {
    const boundStart = HostLogRowSchema.parse({
      ...first,
      event: {
        ...first.event,
        snapshot: {
          configuration: {},
          maxSteps: 12,
          toolIdentities: {},
          workspaceBinding: { operatingRootDisplayName: 'Workspace A', operatingRootId: 'root-a' },
        },
      },
    });
    const ledger = new HostThreadLedger();
    ledger.accept(
      threadId,
      rows.map((row) => (row === first ? boundStart : row))
    );
    // Each run commits two steps of 1 input / 25 output; unattributed first, as the SQL orders.
    expect(ledger.getSnapshot().rootUsage).toEqual([
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

  test("an unbound run's provider calls count toward the root focused at its Send", () => {
    // The desktop's durable run configuration commits the Send intent, focused root included.
    const focusedStart = HostLogRowSchema.parse({
      ...first,
      event: {
        ...first.event,
        snapshot: {
          configuration: { intent: { selectionFolderId: 'root-b' } },
          maxSteps: 12,
          toolIdentities: {},
        },
      },
    });
    const ledger = new HostThreadLedger();
    ledger.accept(
      threadId,
      rows.map((row) => (row === first ? focusedStart : row))
    );
    // The roots table names it; the run's log carries only its id.
    expect(
      ledger.getSnapshot().rootUsage.map(({ rootDisplayName, rootId }) => [rootId, rootDisplayName])
    ).toEqual([
      [null, null],
      ['root-b', null],
    ]);
  });

  test("observer calls cost under the run's resolved observer target, never a local one", () => {
    const observing = (observerTarget: string) =>
      HostLogRowSchema.parse({
        ...first,
        event: {
          ...first.event,
          snapshot: {
            configuration: {
              memoryResolution: { observationalMemory: 'resolved', observerTarget },
            },
            maxSteps: 12,
            toolIdentities: {},
          },
        },
      });
    // The memory provider commits the SDK model's own id.
    const observation = (modelId: string) => ({
      kind: 'observation',
      modelId,
      runId,
      type: 'memory.usage',
      usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
    });
    const costedSources = (observerTarget: string, modelId: string) => {
      const ledger = new HostThreadLedger();
      const at = rows.indexOf(first);
      ledger.accept(
        threadId,
        [
          ...rows.slice(0, at),
          observing(observerTarget),
          { event: observation(modelId), seq: 0, threadId },
          ...rows.slice(at + 1),
        ].map((row, index) =>
          HostLogRowSchema.parse({ ...row, seq: index + 1, ts: BASE + (index + 1) * 1000 })
        )
      );
      return ledger
        .getThreadUsage(threadId)
        ?.perModel.map(({ model, provider, runKind }) => [provider, model, runKind]);
    };
    expect(costedSources('openai/gpt-4.1-mini', 'gpt-4.1-mini')).toEqual([
      ['openai', 'gpt-4.1-mini', 'om-observation'],
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
    expect(costedSources('openrouter/google/gemini-2.5-flash', 'google/gemini-2.5-flash')).toEqual([
      ['openrouter', 'google/gemini-2.5-flash', 'om-observation'],
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
    // A call naming another model than the target is not attributed to it.
    expect(costedSources('openai/gpt-4.1-mini', 'gpt-4.1')).toEqual([
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
    // The built-in local model bills nothing.
    expect(costedSources('local/gemma-4-e2b-it', 'gemma-4-e2b-it')).toEqual([
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'chat'],
    ]);
  });
});
