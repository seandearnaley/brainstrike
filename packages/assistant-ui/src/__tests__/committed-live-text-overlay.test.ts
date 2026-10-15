// @vitest-environment node
import { TOOL_TELEMETRY_OMITTED_TYPE } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import { committedStepParts } from '../committed-step-text';
import emptyReasoning from './fixtures/luna-empty-reasoning.json';

const rows: readonly CommittedAssistantLogRow[] = recording;
const start = rows.find(({ event }) => event['type'] === 'run.started');
const recordedRunId = start?.event['runId'];
if (!(start && typeof recordedRunId === 'string')) {
  throw new Error('The recording has no run.');
}
const runId: string = recordedRunId;
const threadId: string = start.threadId;

function projector(): CommittedAssistantLogProjection {
  return new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-09T08:00:00.000Z'),
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: 'recorded-prompt',
    }),
    threadId,
  });
}

function texts(projection: CommittedAssistantLogProjection) {
  const answer = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  return (answer?.content ?? []).flatMap((part) =>
    part.type === 'text' ? [{ status: part.status, text: part.text }] : []
  );
}

/**
 * The model's text is live `run/telemetry`, never committed deltas (ADR-0011
 * amendment): the open step shows it live, and its committed `model.step`
 * parts replace it when the step commits.
 */
it('shows a step’s live text, then its committed text once the step commits', () => {
  const projection = projector();
  const finalStep = rows.findLastIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { type?: string })?.type === 'start-step'
  );
  const committed = rows.findLastIndex(({ event }) => event['type'] === 'model.step');
  projection.acceptCommitted(rows.slice(0, finalStep + 1));
  projection.acceptLive(runId, { id: 'text-1', type: 'text-start' });
  projection.acceptLive(runId, { id: 'text-1', text: 'Host run ', type: 'text-delta' });
  expect(texts(projection)).toEqual([{ status: { type: 'running' }, text: 'Host run ' }]);
  projection.acceptLive(runId, { id: 'text-1', text: 'completed.', type: 'text-delta' });
  projection.acceptLive(runId, { id: 'text-1', type: 'text-end' });
  expect(texts(projection)).toEqual([
    { status: { type: 'complete' }, text: 'Host run completed.' },
  ]);

  projection.acceptCommitted(rows.slice(finalStep + 1, committed + 1));
  expect(texts(projection)).toEqual([
    { status: { type: 'complete' }, text: 'Host run completed.' },
  ]);
  // Live chunks for a committed step are no longer shown.
  projection.acceptLive(runId, { id: 'text-1', text: ' Late.', type: 'text-delta' });
  projection.acceptCommitted(rows.slice(committed + 1));
  expect(texts(projection)).toEqual([
    { status: { type: 'complete' }, text: 'Host run completed.' },
  ]);

  // A reload folds the committed log alone and shows the same text.
  const reloaded = projector();
  reloaded.acceptCommitted(rows);
  expect(texts(reloaded)).toEqual(texts(projection));
});

it('never folds text from a committed delta an older log holds', () => {
  const projection = projector();
  const finalStep = rows.findLastIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { type?: string })?.type === 'start-step'
  );
  const step = rows[finalStep];
  if (!step) {
    throw new Error('The recording has no final step.');
  }
  projection.acceptCommitted(rows.slice(0, finalStep + 1));
  projection.acceptCommitted([
    {
      ...step,
      event: {
        chunk: { id: 'text-1', text: 'Old delta', type: 'text-delta' },
        runId,
        type: 'stream.chunk',
      },
      seq: step.seq + 1,
    },
  ]);
  expect(texts(projection)).toEqual([]);
});

it('a replay that dropped the step’s oldest text opens with a visible notice until the step commits', () => {
  const projection = projector();
  const finalStep = rows.findLastIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { type?: string })?.type === 'start-step'
  );
  const committed = rows.findLastIndex(({ event }) => event['type'] === 'model.step');
  projection.acceptCommitted(rows.slice(0, finalStep + 1));
  // A call's omission belongs to its command's live output, not to the reply.
  projection.acceptLive(runId, {
    omittedBytes: 900,
    resumesAt: 1,
    toolCallId: 'command-1',
    type: TOOL_TELEMETRY_OMITTED_TYPE,
  });
  projection.acceptLive(runId, {
    omittedBytes: 2048,
    resumesAt: 4,
    type: TOOL_TELEMETRY_OMITTED_TYPE,
  });
  projection.acceptLive(runId, { id: 'text-1', text: 'completed.', type: 'text-delta' });
  expect(texts(projection)).toEqual([
    { status: { type: 'complete' }, text: 'Earlier reply text not shown (2 KB)' },
    { status: { type: 'running' }, text: 'completed.' },
  ]);

  projection.acceptCommitted(rows.slice(finalStep + 1, committed + 1));
  expect(texts(projection)).toEqual([
    { status: { type: 'complete' }, text: 'Host run completed.' },
  ]);
});

// October 12 owner export: encrypted reasoning items have no visible summary.
it('omits recorded empty thinking disclosures while retaining the answer and visible reasoning', () => {
  const original = JSON.stringify(emptyReasoning);
  const parts = committedStepParts(emptyReasoning);
  expect(parts.some(({ part }) => part.type === 'reasoning')).toBe(false);
  expect(parts.some(({ part }) => part.type === 'text' && part.text.length > 0)).toBe(true);
  expect(JSON.stringify(emptyReasoning)).toBe(original);
  expect(
    committedStepParts([
      {
        content: [
          { text: '  \n', type: 'reasoning' },
          { text: 'Visible reasoning.', type: 'reasoning' },
        ],
        role: 'assistant',
      },
    ]).map(({ part }) => part.text)
  ).toEqual(['Visible reasoning.']);
});

function reasonings(projection: CommittedAssistantLogProjection) {
  const answer = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  return (answer?.content ?? []).flatMap((part) =>
    part.type === 'reasoning' ? [{ status: part.status, text: part.text }] : []
  );
}

// October 14 owner screenshot: the open step drew the same empty disclosure live.
it('shows no live thinking row for an open step’s opaque reasoning, yet streams readable reasoning', () => {
  const projection = projector();
  const finalStep = rows.findLastIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { type?: string })?.type === 'start-step'
  );
  const committed = rows.findLastIndex(({ event }) => event['type'] === 'model.step');
  projection.acceptCommitted(rows.slice(0, finalStep + 1));
  const itemId = emptyReasoning[0]?.content[0]?.providerOptions.openai.itemId;
  const providerMetadata = { openai: { itemId, reasoningEncryptedContent: 'opaque-state' } };
  projection.acceptLive(runId, { id: `${itemId}:0`, providerMetadata, type: 'reasoning-start' });
  expect(reasonings(projection)).toEqual([]);
  projection.acceptLive(runId, { id: `${itemId}:0`, providerMetadata, type: 'reasoning-end' });
  expect(reasonings(projection)).toEqual([]);

  projection.acceptLive(runId, { id: 'reasoning-2', type: 'reasoning-start' });
  projection.acceptLive(runId, { id: 'reasoning-2', text: '\n', type: 'reasoning-delta' });
  expect(reasonings(projection)).toEqual([]);
  projection.acceptLive(runId, {
    id: 'reasoning-2',
    text: 'Checking the store.',
    type: 'reasoning-delta',
  });
  expect(reasonings(projection)).toEqual([
    { status: { type: 'running' }, text: 'Checking the store.' },
  ]);

  // The committed step owns its parts; the recording's step carries no reasoning.
  projection.acceptCommitted(rows.slice(finalStep + 1, committed + 1));
  expect(reasonings(projection)).toEqual([]);
});
