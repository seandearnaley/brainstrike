// @vitest-environment node
// Actual standalone host recording (real bin, record-hooks-skipped-log.mjs): a
// launch root's project hooks file has no trust, so the run commits
// `hooks.skipped` and the question it would have blocked is asked.
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;
const start = rows.find(({ event }) => event['type'] === 'run.started');
const skip = rows.find(({ event }) => event['type'] === 'hooks.skipped');
const files = skip?.event['files'];
const path: unknown = Array.isArray(files) ? files[0]?.path : undefined;
if (!start || typeof start.event['runId'] !== 'string' || typeof path !== 'string') {
  throw new Error('Missing committed recording rows.');
}
const runId = start.event['runId'];
const createdAt = new Date('2026-10-09T03:00:00.000Z');

it('shows each hook file the run skipped as an always-visible notice with the Settings remedy', () => {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({ assistantMessageId: runId, createdAt, parentMessageId: null }),
    threadId: start.threadId,
  });
  projection.acceptCommitted(rows);
  const message = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing projected recorded answer.');
  }
  const notices = message.content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'hook.notice' ? [event] : [];
  });
  expect(notices).toEqual([
    expect.objectContaining({
      detail: `${path}: not trusted — review it in Settings > Hooks`,
      label: 'Project hooks not trusted',
      metadata: { path, reason: 'untrusted' },
      runId,
      status: 'failed',
    }),
  ]);
  expect(notices.every((event) => isAlwaysVisibleRunEvent(event))).toBe(true);
  // Only a failure is forced visible; hook feedback stays in the activity group.
  expect(notices.map((event) => isAlwaysVisibleRunEvent({ ...event, status: 'info' }))).toEqual([
    false,
  ]);
});
