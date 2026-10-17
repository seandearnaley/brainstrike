import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import approvedRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import questionRecording from '@brainstrike/test-utils/fixtures/committed-host-question.json';
import { Schema } from 'effect';
import { expect, test, vi } from 'vitest';
import { type CommittedHostRunSource, HostThreadRuns } from '../renderer/host-thread-runs';
// Ordinary app-owned SQLite rows: the runtime shape carries a commit `ts` on every row.
import appOwnedRecording from './fixtures/committed-app-owned-host-thread.json';

const approved = approvedRecording.map((row) =>
  Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
);
const question = questionRecording.map((row) =>
  Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
);
const committedAt = Schema.decodeUnknownSync(HostLogRowSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})(appOwnedRecording[0]).ts;
const threadId = approved[0]?.threadId;
if (!(threadId && committedAt !== undefined)) {
  throw new Error('Recorded host rows are required');
}
function indexOf(rows: readonly HostLogRow[], type: string): number {
  const index = rows.findIndex((row) => row.event.type === type);
  if (index < 0) {
    throw new Error(`The recording has no ${type}`);
  }
  return index;
}
/** A recording whose last terminal row carries `outcome` and a commit time, as Core commits it. */
function finishedAs(
  outcome: 'completed' | 'failed' | 'interrupted' | 'stopped',
  rows: readonly HostLogRow[] = approved
): HostLogRow[] {
  const last = rows.findLastIndex((row) => row.event.type === 'run.finished');
  return rows.map((row, index) =>
    index === last && row.event.type === 'run.finished'
      ? { ...row, event: { ...row.event, outcome }, ts: committedAt }
      : row
  );
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
  replay(rows: readonly HostLogRow[]): void {
    this.publish({ isLoading: false, replayedThrough: rows.at(-1)?.seq ?? 0, rows });
  }
  live(rows: readonly HostLogRow[]): void {
    this.publish({ ...this.snapshot, rows });
  }
  private publish(snapshot: ReturnType<CommittedHostRunSource['getSnapshot']>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
test("Core's latest run reads as the thread badge's run, its finish time a date", () => {
  const runs = new HostThreadRuns();
  runs.seed([
    [threadId, { completedAt: committedAt, needsInput: false, seq: 9, status: 'failed' }],
  ]);
  expect(runs.getSnapshot().get(threadId)).toEqual({
    completedAt: new Date(committedAt),
    needsInput: false,
    status: 'failed',
  });
});
test('an older catalog read never replaces a newer observed run state', () => {
  const runs = new HostThreadRuns();
  const source = new Source();
  const stop = runs.observe(threadId, source, vi.fn());
  source.replay(finishedAs('completed'));
  const finished = runs.getSnapshot();
  const finishedSeq = approved[indexOf(approved, 'run.finished')]?.seq ?? 0;
  // A catalog read taken before the run finished.
  runs.seed([
    [threadId, { completedAt: null, needsInput: true, seq: finishedSeq - 1, status: 'running' }],
  ]);
  expect(runs.getSnapshot()).toBe(finished);
  // A later read wins: the thread's next run started after the view's last row.
  runs.seed([
    [threadId, { completedAt: null, needsInput: false, seq: finishedSeq + 5, status: 'running' }],
  ]);
  expect(runs.getSnapshot().get(threadId)?.status).toBe('running');
  stop();
  runs.delete(threadId);
  expect(runs.getSnapshot().has(threadId)).toBe(false);
});
test('only rows committed after the replay notify; a replayed approval never does', () => {
  const source = new Source();
  const runs = new HostThreadRuns();
  const onNotification = vi.fn();
  const stop = runs.observe(threadId, source, onNotification);
  expect(runs.getSnapshot().has(threadId)).toBe(false);
  // Replayed through the approval request; the run waits on its user.
  source.replay(approved.slice(0, indexOf(approved, 'interaction.requested') + 1));
  expect(runs.getSnapshot().get(threadId)).toEqual({
    completedAt: null,
    needsInput: true,
    status: 'running',
  });
  expect(onNotification).not.toHaveBeenCalled();
  source.live(finishedAs('completed'));
  expect(runs.getSnapshot().get(threadId)).toEqual({
    completedAt: new Date(committedAt),
    needsInput: false,
    status: 'completed',
  });
  const started = approved[indexOf(approved, 'run.started')]?.event;
  expect(onNotification.mock.calls).toEqual([
    [{ kind: 'runFinished', runId: started && 'runId' in started ? started.runId : undefined }],
  ]);
  stop();
});
test('a live approval request and failed run notify once each; a Stop does not', () => {
  const started = approved[indexOf(approved, 'run.started')]?.event;
  const requested = approved[indexOf(approved, 'interaction.requested')]?.event;
  if (!(started?.type === 'run.started' && requested?.type === 'interaction.requested')) {
    throw new Error('The recording has no approved run');
  }
  for (const [outcome, expected] of [
    ['failed', { kind: 'runFailed', runId: started.runId }],
    ['interrupted', { kind: 'runFailed', runId: started.runId }],
    ['stopped', undefined],
  ] as const) {
    const source = new Source();
    const onNotification = vi.fn();
    new HostThreadRuns().observe(threadId, source, onNotification);
    source.replay(approved.slice(0, indexOf(approved, 'run.started') + 1));
    source.live(finishedAs(outcome));
    expect(onNotification.mock.calls).toEqual([
      [
        {
          decisionKey: requested.interactionId,
          kind: 'toolApprovalRequired',
          runId: started.runId,
        },
      ],
      ...(expected ? [[expected]] : []),
    ]);
  }
});
test('a live question notifies as one, in the approval notification kind', () => {
  const requested = question[indexOf(question, 'interaction.requested')]?.event;
  if (requested?.type !== 'interaction.requested' || requested.kind !== 'question') {
    throw new Error('The recording has no question');
  }
  const source = new Source();
  const onNotification = vi.fn();
  new HostThreadRuns().observe(threadId, source, onNotification);
  source.replay(question.slice(0, indexOf(question, 'run.started') + 1));
  source.live(question.slice(0, indexOf(question, 'interaction.requested') + 1));
  expect(onNotification.mock.calls).toEqual([
    [
      {
        decisionKey: requested.interactionId,
        input: 'question',
        kind: 'toolApprovalRequired',
        runId: requested.runId,
      },
    ],
  ]);
});
