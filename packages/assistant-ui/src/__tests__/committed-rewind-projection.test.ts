// @vitest-environment node
// Actual HostCore + StateStore recording (record-rewind-log.mjs): runs A and B;
// a conversation-only rewind to before B; its redo; a second rewind to before
// B; then run C, whose committed parent is A.
import recording from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;
const runIds = rows.flatMap(({ event }) =>
  event['type'] === 'run.started' && typeof event['runId'] === 'string' ? [event['runId']] : []
);
const [runA, runB, runC] = runIds;
const after = (type: string, nth = 0) =>
  rows.filter(({ event }) => event['type'] === type)[nth]?.seq ?? Number.NaN;

/** The projection's head after the rows through `seq`; message ids are run ids here. */
function headThrough(seq: number): string | null | undefined {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: (row) => ({
      assistantMessageId: String(row.event['runId']),
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
      parentMessageId: null,
      userMessageId: `user-${String(row.event['runId'])}`,
    }),
    threadId: rows[0]?.threadId ?? '',
  });
  return projection.acceptCommitted(rows.filter((row) => row.seq <= seq)).repository.headId;
}

it('a rewind moves the head to the run before the message, its redo back, and the next run branches there', () => {
  expect(runIds).toHaveLength(3);
  // The intent alone does not move the head; the outcome does.
  expect(headThrough(after('thread.rewind.started'))).toBe(runB);
  expect(headThrough(after('thread.rewound'))).toBe(runA);
  expect(headThrough(after('thread.rewind.redo.started'))).toBe(runA);
  expect(headThrough(after('thread.rewind.redone'))).toBe(runB);
  expect(headThrough(after('thread.rewound', 1))).toBe(runA);
  expect(headThrough(Number.POSITIVE_INFINITY)).toBe(runC);
  // Run C answers from A; B's branch stays in the repository.
  const repository = new CommittedAssistantLogProjection({
    identifyRun: (row) => ({
      assistantMessageId: String(row.event['runId']),
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
      parentMessageId:
        typeof row.event['parentMessageId'] === 'string' ? row.event['parentMessageId'] : null,
      userMessageId: `user-${String(row.event['runId'])}`,
    }),
    threadId: rows[0]?.threadId ?? '',
  }).acceptCommitted(rows).repository;
  const parentOf = (id: string | undefined) =>
    repository.messages.find(({ message }) => message.id === id)?.parentId;
  expect(parentOf(`user-${runC}`)).toBe(runA);
  expect(parentOf(`user-${runB}`)).toBe(runA);
});
