import answerless from '@brainstrike/test-utils/fixtures/committed-host-answerless-runs.json';
import answeredRecording from '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.ts';
import { HostThreadSummaries } from '../src/thread-summary.ts';

const row = (seq: number, event: Record<string, unknown>, threadId = 'child'): HostLogRow =>
  ({ event, seq, threadId, ts: seq }) as unknown as HostLogRow;

function fed(rows: readonly HostLogRow[]): HostThreadSummaries {
  const summaries = new HostThreadSummaries();
  for (const entry of rows) {
    summaries.apply(entry);
  }
  return summaries;
}

const asked = (seq: number, interactionId: string, kind: string, runId = 'delegated') =>
  row(seq, {
    input: {},
    interactionId,
    kind,
    runId,
    toolCallId: `call-${interactionId}`,
    toolId: 'write_file',
    toolIdentity: 'native-write-generation-1',
    type: 'interaction.requested',
  });

// A child re-run through input, Retry or Edit starts its own turn (core-child-runs
// `adopt`: a child's first run is the delegated invocation, any later run a
// follow-up), so the parent's turn Stop cannot end it.
test('a child running its delegated invocation, then a follow-up turn of its own', () => {
  const summaries = fed([row(1, { runId: 'delegated', type: 'run.started' })]);
  expect(summaries.read('child').run).toEqual({
    delegatedInvocation: true,
    status: 'running',
    toolCalls: 0,
    turnId: 'delegated',
  });

  summaries.apply(row(2, { outcome: 'completed', runId: 'delegated', type: 'run.finished' }));
  summaries.apply(row(3, { runId: 'follow-up', type: 'run.started' }));
  expect(summaries.read('child').run).toMatchObject({
    delegatedInvocation: false,
    status: 'running',
  });
});

// The composer's Stop ends only its run's turn. A wake continues the turn it
// delivers; a user run starts its own (`hostRootRunTurnId`).
test('a root thread’s run names its turn: its own, or the turn its wake delivers', () => {
  const summaries = fed([
    row(1, { runId: 'turn-a', type: 'run.started' }, 'root'),
    row(2, { outcome: 'completed', runId: 'turn-a', type: 'run.finished' }, 'root'),
    row(
      3,
      {
        delivery: { entries: [], messageId: 'm', turnId: 'turn-a', via: 'wake' },
        runId: 'wake-1',
        type: 'run.started',
      },
      'root'
    ),
  ]);
  expect(summaries.read('root').run?.turnId).toBe('turn-a');
  summaries.apply(row(4, { outcome: 'completed', runId: 'wake-1', type: 'run.finished' }, 'root'));
  summaries.apply(row(5, { runId: 'turn-b', type: 'run.started' }, 'root'));
  expect(summaries.read('root').run?.turnId).toBe('turn-b');
});

test('a thread that has not started has no run', () => {
  expect(new HostThreadSummaries().read('child')).toEqual({ answered: [], pending: [], run: null });
});

test('a waiting interaction is pending until it is answered, and an answered approval is kept', () => {
  const summaries = fed([
    row(1, { runId: 'delegated', type: 'run.started' }),
    asked(2, 'approve-write', 'approval'),
    asked(3, 'which-root', 'question'),
  ]);
  expect(summaries.read('child').run?.status).toBe('needs-input');
  expect(summaries.read('child').pending.map((entry) => entry.interactionId)).toEqual([
    'approve-write',
    'which-root',
  ]);

  summaries.apply(
    row(4, {
      by: 'policy',
      decision: 'approve',
      interactionId: 'approve-write',
      runId: 'delegated',
      type: 'interaction.responded',
    })
  );
  const summary = summaries.read('child');
  expect(summary.pending.map((entry) => entry.interactionId)).toEqual(['which-root']);
  expect(summary.answered).toMatchObject([
    { approval: { interactionId: 'approve-write' }, byPolicy: true, decision: 'approve' },
  ]);

  // A run that ends takes its unanswered interactions with it.
  summaries.apply(row(5, { outcome: 'stopped', runId: 'delegated', type: 'run.finished' }));
  expect(summaries.read('child').pending).toEqual([]);
  expect(summaries.read('child').run?.status).toBe('stopped');
});

test('only a row that changes the summary is its revision, and the summary keeps its identity', () => {
  const summaries = fed([row(1, { runId: 'delegated', type: 'run.started' })]);
  expect(summaries.changedBy({ seq: 1, threadId: 'child' })).toBe(true);
  const before = summaries.read('child');
  summaries.apply(
    row(2, { output: {}, runId: 'delegated', toolCallId: 'x', type: 'effect.finished' })
  );
  expect(summaries.changedBy({ seq: 2, threadId: 'child' })).toBe(false);
  expect(summaries.read('child')).toBe(before);
});

// A background child's delegation result stays the `started` acknowledgement,
// so its card reads how it ended from this summary. A child that completes
// without writing an answer is the host's `no-answer` (`hostChildResult`),
// never a success. Real-host recordings:
// - answerless: a run that calls a tool, then only reasons before it stops
//   (completed, no text), then a run that streams nothing (the empty-response
//   guard fails it);
// - incremental tool input: a run whose last step writes its answer.
const recorded = (recording: unknown): HostLogRow[] =>
  Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(recording);

test('a child that completes without writing an answer reads no-answer, never finished', () => {
  const rows = recorded(answerless);
  const firstFinished = rows.findIndex((entry) => entry.event.type === 'run.finished');
  const threadId = rows[0]?.threadId ?? '';
  const summaries = fed(rows.slice(0, firstFinished + 1));
  expect(summaries.read(threadId).run).toMatchObject({ status: 'no-answer', toolCalls: 1 });
  for (const entry of rows.slice(firstFinished + 1)) {
    summaries.apply(entry);
  }
  expect(summaries.read(threadId).run).toMatchObject({ status: 'failed', toolCalls: 1 });
});

test('a child whose last step writes its answer reads completed', () => {
  const rows = recorded(answeredRecording);
  expect(fed(rows).read(rows[0]?.threadId ?? '').run).toMatchObject({
    status: 'completed',
    toolCalls: 1,
  });
});
