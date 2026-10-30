// @vitest-environment node
// BST-2311: a throttled view shows a streamed reply's live text in timed
// updates, not one per chunk, and a committed row still lands after every live
// chunk that arrived before it.
import liveTextRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run-telemetry.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommittedAssistantLogStore } from '../committed-assistant-log-store';
import {
  answerStepLength,
  committedRows,
  RecordedCommittedSource,
  recordedPromptId,
  recordedRunId,
  recordedThreadId,
} from './committed-recording-support';

const [start, delta, end] = liveTextRecording;
if (!(start && delta && end)) {
  throw new Error('The recorded telemetry has no text stream.');
}

function throttledStore(source: RecordedCommittedSource) {
  return new CommittedAssistantLogStore({
    identifyRun: () => ({
      assistantMessageId: recordedRunId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: recordedRunId } },
      parentMessageId: null,
      userMessageId: recordedPromptId,
    }),
    liveTelemetryThrottleMs: 50,
    source,
    threadId: recordedThreadId,
  });
}

/** The live answer's text as the view shows it. */
function shownText(store: CommittedAssistantLogStore): string {
  const answer = store
    .getSnapshot()
    .repository.messages.map(({ message }) => message)
    .findLast((message) => message.role === 'assistant');
  return (answer?.content ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

describe('a throttled committed view', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows many live chunks in one timed update', () => {
    const source = new RecordedCommittedSource();
    source.publishPrefix(answerStepLength);
    const store = throttledStore(source);
    let updates = 0;
    store.subscribe(() => {
      updates += 1;
    });
    store.acceptTelemetry(start.runId, start.chunk);
    for (let index = 0; index < 20; index += 1) {
      store.acceptTelemetry(delta.runId, delta.chunk);
    }
    expect(updates).toBe(0);
    vi.advanceTimersByTime(50);
    expect(updates).toBe(1);
    expect(shownText(store)).toBe(String(delta.chunk['text']).repeat(20));
    store.dispose();
  });

  it('applies live chunks that arrived before a committed row ahead of it', () => {
    const source = new RecordedCommittedSource();
    source.publishPrefix(answerStepLength);
    const store = throttledStore(source);
    store.acceptTelemetry(start.runId, start.chunk);
    store.acceptTelemetry(delta.runId, delta.chunk);
    store.acceptTelemetry(end.runId, end.chunk);
    // The step's committed text replaces the live text it follows.
    source.publishPrefix(committedRows.length);
    const committed = shownText(store);
    vi.advanceTimersByTime(50);
    expect(shownText(store)).toBe(committed);
    expect(committed.length).toBeGreaterThan(0);
    store.dispose();
  });
});
