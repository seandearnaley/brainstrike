// @vitest-environment node
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { expect, test } from 'vitest';
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

test('a child that has not started reports no delegated invocation', () => {
  const fold = new HostChildRunFold();
  expect(fold.apply([])).toBeUndefined();
  expect(fold.runsDelegatedInvocation()).toBe(false);
});
