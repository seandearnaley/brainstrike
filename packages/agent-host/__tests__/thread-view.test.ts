import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostLogRowSchema } from '../src/protocol.js';
import { CommittedThreadView, foldHostRuns } from '../src/thread-view.js';

const rows = z.array(HostLogRowSchema).parse(recording);
const threadId = rows[0]?.threadId;
if (!threadId) {
  throw new Error('The runtime recording has no thread');
}

test('recorded approved host run folds into completed output with no open approval', () => {
  const [run] = foldHostRuns(rows);
  const text = rows
    .flatMap(({ event }) => {
      if (
        event.type !== 'stream.chunk' ||
        !event.chunk ||
        typeof event.chunk !== 'object' ||
        Array.isArray(event.chunk)
      ) {
        return [];
      }
      return event.chunk['type'] === 'text-delta' ? [event.chunk['text']] : [];
    })
    .join('');
  expect(run?.status).toBe('completed');
  expect(run?.text).toBe(text);
  expect(run?.approvals).toEqual([]);
  expect(run?.results).toEqual(
    rows.map((row) => row.event).filter((item) => item.type === 'effect.finished')
  );
});

test('recorded pause stays visible until its committed response arrives', () => {
  const response = rows.findIndex((row) => row.event.type === 'interaction.responded');
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  expect(foldHostRuns(rows.slice(0, response))[0]?.approvals).toEqual([requested]);
  expect(foldHostRuns(rows.slice(0, response + 1))[0]?.approvals).toEqual([]);
});

test('reordered replay/live overlap displays only a contiguous committed prefix once', () => {
  const view = new CommittedThreadView(threadId);
  let publications = 0;
  view.subscribe(() => {
    publications += 1;
  });
  view.accept(rows.slice(1).toReversed());
  expect(view.getSnapshot()).toEqual([]);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  expect(publications).toBe(1);
});

test('another thread cannot enter the selected committed view', () => {
  const view = new CommittedThreadView(threadId);
  view.accept(rows.map((row) => ({ ...row, threadId: 'other-recording' })));
  expect(view.getSnapshot()).toEqual([]);
});
