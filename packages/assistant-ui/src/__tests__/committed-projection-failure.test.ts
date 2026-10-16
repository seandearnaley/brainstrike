// @vitest-environment node
// A committed row the presentation cannot read must fail the view visibly. It
// must never escape into the owner's event delivery: there it was swallowed as
// a console error, froze the transcript mid-run, and left Stop naming a run
// that had already ended (2026-10-15 debug pack).

import approvedRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import recording from '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import {
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';

const rows: readonly CommittedAssistantLogRow[] = recording;
const malformedIndex = rows.findIndex(
  ({ event }) =>
    event['type'] === 'stream.chunk' &&
    (event['chunk'] as Record<string, unknown>)['type'] === 'tool-input-delta'
);
const { malformed, runId } = (() => {
  const recorded = rows.find(({ event }) => event['type'] === 'run.started')?.event['runId'];
  const row = rows[malformedIndex];
  if (typeof recorded !== 'string' || !row) {
    throw new Error('Missing committed recording identities.');
  }
  return { malformed: row, runId: recorded };
})();
// A delta that is not text at all: no reading of it is truthful.
const corrupted: readonly CommittedAssistantLogRow[] = rows.map((row, index) =>
  index === malformedIndex
    ? {
        ...row,
        event: { ...row.event, chunk: { ...(row.event['chunk'] as object), delta: 42 } },
      }
    : row
);

function source(initial: readonly CommittedAssistantLogRow[]) {
  const listeners = new Set<() => void>();
  let snapshot: CommittedAssistantLogSourceSnapshot = {
    connected: true,
    error: undefined,
    rows: initial,
  };
  return {
    append(next: readonly CommittedAssistantLogRow[]) {
      snapshot = { ...snapshot, rows: [...snapshot.rows, ...next] };
      for (const listener of listeners) {
        listener();
      }
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function store(initial: readonly CommittedAssistantLogRow[]) {
  const owner = source(initial);
  const view = new CommittedAssistantLogStore({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-16T03:18:00.000Z'),
      parentMessageId: null,
    }),
    source: owner,
    threadId: rows[0]?.threadId ?? '',
  });
  return { owner, view };
}

describe('a committed row the presentation cannot read', () => {
  it('fails the conversation visibly, naming the row, without throwing into delivery', () => {
    const { owner, view } = store(corrupted.slice(0, malformedIndex));
    let published = 0;
    view.subscribe(() => {
      published += 1;
    });
    expect(view.getSnapshot().error).toBeUndefined();
    expect(() => owner.append(corrupted.slice(malformedIndex, malformedIndex + 1))).not.toThrow();
    expect(published).toBe(1);
    expect(view.getSnapshot().error).toBe(
      `This conversation cannot be shown past committed row ${malformed.seq} (stream.chunk tool-input-delta): Committed host event is missing delta.`
    );
  });

  it('stays failed at that row as later rows commit', () => {
    const { owner, view } = store(corrupted.slice(0, malformedIndex + 1));
    const failed = view.getSnapshot();
    expect(failed.error).toContain(`committed row ${malformed.seq}`);
    expect(() => owner.append(corrupted.slice(malformedIndex + 1))).not.toThrow();
    expect(view.getSnapshot()).toBe(failed);
  });

  it('publishes nothing a failed row changed before it threw, and stays failed', () => {
    // A request without its tool identity: the call's approval is written
    // first, then reading the identity throws.
    const approved: readonly CommittedAssistantLogRow[] = approvedRecording;
    const at = approved.findIndex(({ event }) => event['type'] === 'interaction.requested');
    const broken = approved.map((row, index) => {
      if (index !== at) {
        return row;
      }
      const { toolIdentity: _identity, ...event } = row.event;
      return { ...row, event };
    });
    const runId = approved.find(({ event }) => event['type'] === 'run.started')?.event['runId'];
    const projection = new CommittedAssistantLogProjection({
      identifyRun: () => ({
        assistantMessageId: String(runId),
        createdAt: new Date('2026-10-16T03:18:00.000Z'),
        parentMessageId: null,
      }),
      threadId: approved[0]?.threadId ?? '',
    });
    const before = projection.acceptCommitted(broken.slice(0, at));
    expect(() => projection.acceptCommitted(broken.slice(at, at + 1))).toThrow(
      'Committed host event is missing toolIdentity.'
    );
    expect(projection.getSnapshot()).toBe(before);
    expect(() => projection.acceptCommitted(broken)).toThrow(
      `committed row ${broken[at]?.seq} (interaction.requested)`
    );
    expect(projection.getSnapshot()).toBe(before);
  });
});
