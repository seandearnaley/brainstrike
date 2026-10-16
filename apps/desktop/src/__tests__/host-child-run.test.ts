// @vitest-environment node
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import answerless from '@brainstrike/test-utils/fixtures/committed-host-answerless-runs.json';
import answered from '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostChildRunFold } from '../renderer/host-child-run';

const row = (seq: number, event: Record<string, unknown>): HostLogRow =>
  ({ event, seq, threadId: 'child', ts: seq }) as unknown as HostLogRow;

// Codex review on #3719: a child re-run through input, Retry or Edit starts its
// own turn (core-child-runs `adopt`: a child's first run is the delegated
// invocation, any later run a follow-up), so the parent's turn Stop cannot end
// it. The fold says which one the child is running.
test('a child running its delegated invocation, then a follow-up turn of its own', () => {
  const fold = new HostChildRunFold();
  const rows: HostLogRow[] = [row(1, { runId: 'delegated', type: 'run.started' })];
  expect(fold.apply(rows)).toEqual({ status: 'running', toolCalls: 0 });
  expect(fold.runsDelegatedInvocation()).toBe(true);

  rows.push(row(2, { outcome: 'completed', runId: 'delegated', type: 'run.finished' }));
  rows.push(row(3, { runId: 'follow-up', type: 'run.started' }));
  expect(fold.apply(rows)).toEqual({ status: 'running', toolCalls: 0 });
  expect(fold.runsDelegatedInvocation()).toBe(false);
});

// Codex review on #3719: the composer's Stop ends only its run's turn, so the
// strip needs the root's turn. A wake continues the turn it delivers; a user
// run starts its own (agent-host `hostRootRunTurnId`).
test('a root thread’s working run names its turn: its own, or the turn its wake delivers', () => {
  const fold = new HostChildRunFold();
  expect(fold.rootTurnId()).toBeUndefined();
  const rows: HostLogRow[] = [row(1, { runId: 'turn-a', type: 'run.started' })];
  fold.apply(rows);
  expect(fold.rootTurnId()).toBe('turn-a');
  rows.push(row(2, { outcome: 'completed', runId: 'turn-a', type: 'run.finished' }));
  rows.push(
    row(3, {
      delivery: { entries: [], messageId: 'm', turnId: 'turn-a', via: 'wake' },
      runId: 'wake-1',
      type: 'run.started',
    })
  );
  fold.apply(rows);
  expect(fold.rootTurnId()).toBe('turn-a');
  rows.push(row(4, { outcome: 'completed', runId: 'wake-1', type: 'run.finished' }));
  rows.push(row(5, { runId: 'turn-b', type: 'run.started' }));
  fold.apply(rows);
  expect(fold.rootTurnId()).toBe('turn-b');
});

// Codex review on #3719: a child whose log subscription failed has no rows,
// and reading that as "not started yet" left its card on the dispatch
// acknowledgement. Its run reads unavailable, with the session's reason.
test('a child whose log cannot be read is unavailable, with the reason', () => {
  const fold = new HostChildRunFold();
  expect(fold.apply([], 'The agent host is not connected.')).toEqual({
    reason: 'The agent host is not connected.',
    status: 'unavailable',
    toolCalls: 0,
  });
  const rows: HostLogRow[] = [row(1, { runId: 'delegated', type: 'run.started' })];
  expect(fold.apply(rows)).toEqual({ status: 'running', toolCalls: 0 });
  const lost = fold.apply(rows, 'Host is closing');
  expect(lost).toEqual({ reason: 'Host is closing', status: 'unavailable', toolCalls: 0 });
  expect(fold.apply(rows, 'Host is closing')).toBe(lost);
});

test('a child that has not started reports no delegated invocation', () => {
  const fold = new HostChildRunFold();
  expect(fold.apply([])).toBeUndefined();
  expect(fold.runsDelegatedInvocation()).toBe(false);
});

// Codex review on #3719: a background child's delegation result stays the
// `started` acknowledgement, so the card reads the child's own log for how it
// ended. A child that completes without writing an answer is the host's
// `no-answer` (`hostChildResult`), never a success. Real-host recordings:
// - answerless: a run that calls a tool, then only reasons before it stops
//   (completed, no text), then a run that streams nothing (the empty-response
//   guard fails it);
// - incremental tool input: a run whose last step writes its answer.
const recorded = (recording: unknown): HostLogRow[] => z.array(HostLogRowSchema).parse(recording);

test('a child that completes without writing an answer reads no-answer, never finished', () => {
  const rows = recorded(answerless);
  const firstFinished = rows.findIndex((entry) => entry.event.type === 'run.finished');
  const fold = new HostChildRunFold();

  expect(fold.apply(rows.slice(0, firstFinished + 1))).toEqual({
    status: 'no-answer',
    toolCalls: 1,
  });
  expect(fold.apply(rows)).toEqual({ status: 'failed', toolCalls: 1 });
});

test('a child whose last step writes its answer reads completed', () => {
  expect(new HostChildRunFold().apply(recorded(answered))).toEqual({
    status: 'completed',
    toolCalls: 1,
  });
});
