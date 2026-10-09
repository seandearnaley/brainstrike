import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { expect, test } from 'vitest';
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
  expect(ledger.getSnapshot()).toEqual({ runs: [], usage: [] });
});
