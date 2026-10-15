// @vitest-environment node
// Actual HostCore + StateStore recording (record-rewind-log.mjs): runs A and B;
// a conversation-only rewind to before B; its redo; a second rewind to before
// B; then run C, whose committed parent is A.
import recording from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json';
import { expect, it } from 'vitest';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import { ThreadContextReader } from '../thread-context-reader';
import { useThreadContextStore } from '../thread-context-store';

const rows: readonly CommittedAssistantLogRow[] = recording;
const threadId = rows[0]?.threadId ?? '';
const runIds = rows.flatMap(({ event }) =>
  event['type'] === 'run.started' && typeof event['runId'] === 'string' ? [event['runId']] : []
);
const [runA, runB, runC] = runIds;
const through = (type: string, nth = 0) => {
  const seq = rows.filter(({ event }) => event['type'] === type)[nth]?.seq ?? Number.NaN;
  return rows.filter((row) => row.seq <= seq);
};

function reader(): ThreadContextReader {
  return new ThreadContextReader({
    identifyRun: (row) => ({
      assistantMessageId: String(row.event['runId']),
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
      parentMessageId:
        typeof row.event['parentMessageId'] === 'string' ? row.event['parentMessageId'] : null,
      userMessageId: `user-${String(row.event['runId'])}`,
    }),
    threadId,
  });
}

it('follows the displayed branch the conversation projection shows, through a rewind, its redo and a new branch', () => {
  expect(runIds).toHaveLength(3);
  const context = reader();
  expect(context.accept(through('thread.rewound')).branchRunIds).toEqual([runA]);
  expect(context.accept(through('thread.rewind.redone')).branchRunIds).toEqual([runA, runB]);
  const latest = context.accept(rows);
  // Run C answers from A; B's runs stay in the fold, off the branch.
  expect(latest.branchRunIds).toEqual([runA, runC]);
  expect([...latest.snapshot.runs.keys()]).toEqual([runA, runB, runC]);
});

it('returns the same record for unchanged rows and records nothing in the shared store', () => {
  const context = reader();
  const record = context.accept(rows);
  expect(context.accept([...rows])).toBe(record);
  expect(useThreadContextStore.getState().byThread[threadId]).toBeUndefined();
});
