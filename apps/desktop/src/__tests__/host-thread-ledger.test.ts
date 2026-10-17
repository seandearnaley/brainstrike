import { type HostLedgerThread, ThreadLedgerFold } from '@brainstrike/agent-host/ledger-projection';
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostThreadLedger } from '../renderer/host-thread-ledger';
import type { CommittedHostRunSource } from '../renderer/host-thread-runs';

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
/** Core's `ledger/read` entry for a thread whose committed log is `log`. */
function ledgerRead(id: string, log: readonly HostLogRow[]): HostLedgerThread {
  const fold = new ThreadLedgerFold();
  for (const row of log) {
    fold.apply({ ...row, threadId: id });
  }
  return { threadId: id, ...fold.read() };
}
/** The session's published view, driven explicitly. */
class Source implements CommittedHostRunSource {
  private snapshot: ReturnType<CommittedHostRunSource['getSnapshot']> = {
    isLoading: true,
    replayedThrough: undefined,
    rows: [],
  };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(log: readonly HostLogRow[]): void {
    this.snapshot = { isLoading: false, replayedThrough: log.at(-1)?.seq ?? 0, rows: log };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
test("Core's ledger reads as the cost views' runs, provider calls and per-root usage", () => {
  const ledger = new HostThreadLedger();
  const other = 'other-thread';
  ledger.seed([ledgerRead(threadId, rows), ledgerRead(other, rows)]);
  const { rootUsage, runs, usage } = ledger.getSnapshot();
  const [first] = started;
  const runId = first?.event.type === 'run.started' ? first.event.runId : undefined;
  if (!(first && runId)) {
    throw new Error('The recording has no run');
  }
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  // Commit times read as the ledger row's dates.
  expect(runs.find((run) => run.threadId === threadId && run.runId === runId)).toEqual({
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
  expect(runs).toHaveLength(4);
  expect(usage).toHaveLength(8);
  // Both threads' calls sum per (root, provider, model).
  expect(rootUsage).toEqual([
    {
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedInputTokens: 8,
      estimatedOutputTokens: 200,
      inputTokens: 8,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 200,
      provider: 'openrouter',
      rootDisplayName: null,
      rootId: null,
    },
  ]);
});
test("a thread's meter total reads stable until a costed call, and empty before one", () => {
  const ledger = new HostThreadLedger();
  expect(ledger.getThreadUsage(threadId)).toBeUndefined();
  const firstStart = rows.findIndex((row) => row.event.type === 'run.started');
  ledger.seed([ledgerRead(threadId, rows.slice(0, firstStart + 1))]);
  expect(ledger.getThreadUsage(threadId)).toEqual({
    perModel: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
  ledger.seed([ledgerRead(threadId, rows)]);
  const usage = ledger.getThreadUsage(threadId);
  expect(usage).toMatchObject({
    perModel: [{ inputTokens: 4, outputTokens: 100, runKind: 'chat' }],
    totalInputTokens: 4,
    totalOutputTokens: 100,
  });
  // A read of another thread, and the same read again, leave this one's value.
  ledger.seed([ledgerRead(threadId, rows), ledgerRead('another-thread', [])]);
  expect(ledger.getThreadUsage(threadId)).toBe(usage);
});
test("a mounted view's fold and Core's read reconcile by the later committed row", () => {
  const ledger = new HostThreadLedger();
  const second = started[1];
  if (!second) {
    throw new Error('The recording has no second run');
  }
  const early = rows.filter((row) => row.seq <= second.seq);
  ledger.seed([ledgerRead(threadId, rows)]);
  const seeded = ledger.getSnapshot();
  // A view still replaying an earlier part of the log never replaces the later read.
  const source = new Source();
  const release = ledger.observe(threadId, source);
  source.publish(early);
  expect(ledger.getSnapshot()).toBe(seeded);
  // Past it, the view's own fold is current: a tool call Core's read had not seen.
  const call = rows.find(
    (row) =>
      row.event.type === 'stream.chunk' &&
      z.object({ type: z.string() }).parse(row.event.chunk).type === 'tool-call'
  );
  if (!call) {
    throw new Error('The recording has no streamed tool call');
  }
  const toolCalls = () =>
    ledger.getSnapshot().runs.reduce((total, run) => total + run.toolCallCount, 0);
  expect(toolCalls()).toBe(2);
  source.publish([...rows, { ...call, seq: (rows.at(-1)?.seq ?? 0) + 1 }]);
  expect(toolCalls()).toBe(3);
  // An older read of Core's ledger never replaces the view's later fold.
  ledger.seed([ledgerRead(threadId, rows)]);
  expect(toolCalls()).toBe(3);
  // A read that no longer lists the thread keeps a mounted view's fold.
  ledger.seed([]);
  expect(toolCalls()).toBe(3);
  release();
});
test('a thread Core no longer lists, or one this window deleted, leaves the ledger', () => {
  const ledger = new HostThreadLedger();
  ledger.seed([ledgerRead(threadId, rows), ledgerRead('other-thread', rows)]);
  ledger.seed([ledgerRead('other-thread', rows)]);
  expect(new Set(ledger.getSnapshot().runs.map((run) => run.threadId))).toEqual(
    new Set(['other-thread'])
  );
  expect(ledger.getThreadUsage(threadId)).toBeUndefined();
  ledger.delete('other-thread');
  expect(ledger.getSnapshot()).toEqual({ rootUsage: [], runs: [], usage: [] });
});
