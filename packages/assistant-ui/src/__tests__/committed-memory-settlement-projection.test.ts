// @vitest-environment node
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const threadId = 'thread-memory-settlement';
const runId = 'run-memory-settlement';
const promptId = 'prompt-memory-settlement';
const createdAt = new Date('2026-10-16T16:27:01.839Z');
const failedAt = Date.parse('2026-10-16T16:27:38.469Z');
const DETAIL = 'Brainstrike hit an internal error.';

const rows: readonly CommittedAssistantLogRow[] = [
  {
    event: {
      commandId: promptId,
      method: 'run/start',
      payload: { commandId: promptId, prompt: 'Remember Lisbon.', threadId },
      result: { runId },
      type: 'command.accepted',
    },
    seq: 1,
    threadId,
  },
  {
    event: {
      modelId: 'anthropic::claude-sonnet-5',
      prompt: 'Remember Lisbon.',
      runId,
      type: 'run.started',
    },
    seq: 2,
    threadId,
  },
  {
    event: {
      messages: [{ content: [{ text: 'Noted: Lisbon.', type: 'text' }], role: 'assistant' }],
      model: {},
      runId,
      stepNumber: 0,
      type: 'model.step',
      usage: {},
    },
    seq: 3,
    threadId,
  },
  { event: { outcome: 'completed', runId, type: 'run.finished' }, seq: 4, threadId },
  // Mastra's buffered observation the run launched failed after its end.
  {
    event: { detail: DETAIL, runId, type: 'memory.settlement.failed' },
    seq: 5,
    threadId,
    ts: failedAt,
  },
];

it("shows a finished run's failed memory settlement as an always-visible notice", () => {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt,
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: promptId,
    }),
    threadId,
  });
  projection.acceptCommitted(rows);
  const message = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing projected answer.');
  }
  const notices = message.content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'memory.observation.failed' ? [event] : [];
  });
  expect(notices).toEqual([
    expect.objectContaining({
      detail: DETAIL,
      label: 'Background memory failed after this answer',
      runId,
      status: 'failed',
      timestamp: new Date(failedAt).toISOString(),
    }),
  ]);
  expect(notices.every((event) => isAlwaysVisibleRunEvent(event))).toBe(true);
  // The answer's own outcome stands.
  expect(message.status).toEqual({ reason: 'stop', type: 'complete' });
});
