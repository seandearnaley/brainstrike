// @vitest-environment node
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const threadId = 'thread-memory-recall';
const runId = 'run-memory-recall';
const promptId = 'prompt-memory-recall';
const createdAt = new Date('2026-10-20T16:27:01.839Z');
const DETAIL =
  'Memory recall failed because its vector store failed. Reference: 3dc97cea-e1eb-4ab4-9ea3-a66c98320bba';

const rows: readonly CommittedAssistantLogRow[] = [
  {
    event: {
      commandId: promptId,
      method: 'run/start',
      payload: { commandId: promptId, prompt: 'Which city did I mention?', threadId },
      result: { runId },
      type: 'command.accepted',
    },
    seq: 1,
    threadId,
  },
  {
    event: {
      modelId: 'anthropic::claude-sonnet-5',
      prompt: 'Which city did I mention?',
      runId,
      type: 'run.started',
    },
    seq: 2,
    threadId,
  },
  // The turn's recall failed; the turn answered without it.
  { event: { detail: DETAIL, runId, type: 'memory.recall.failed' }, seq: 3, threadId },
  {
    event: {
      messages: [
        { content: [{ text: 'You have not named one.', type: 'text' }], role: 'assistant' },
      ],
      model: {},
      runId,
      stepNumber: 0,
      type: 'model.step',
      usage: {},
    },
    seq: 4,
    threadId,
  },
  { event: { outcome: 'completed', runId, type: 'run.finished' }, seq: 5, threadId },
];

it("shows a turn's failed recall as an always-visible notice beside its answer", () => {
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
    return event?.kind === 'memory.semantic.completed' ? [event] : [];
  });
  expect(notices).toEqual([
    expect.objectContaining({
      detail: DETAIL,
      label: 'Memory recall failed; this answer has no recalled history',
      runId,
      status: 'failed',
      timestamp: createdAt.toISOString(),
    }),
  ]);
  expect(notices.every((event) => isAlwaysVisibleRunEvent(event))).toBe(true);
  // The answer's own outcome stands.
  expect(message.status).toEqual({ reason: 'stop', type: 'complete' });
});
