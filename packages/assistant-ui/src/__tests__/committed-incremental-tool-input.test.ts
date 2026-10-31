// @vitest-environment node
// Actual HostCore + native StateStore capture (record-incremental-tool-input-log.mjs)
// of a provider that streams tool input incrementally, as the OpenRouter
// provider does for GLM, Muse and Qwen: the call opens with an EMPTY input
// delta (the wire's `arguments: ""`). A 2026-10-16 debug pack showed that delta
// freezing every OpenRouter thread view at its first tool call.

import recording from '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;
const runId: string = (() => {
  const recorded = rows.find(({ event }) => event['type'] === 'run.started')?.event['runId'];
  if (typeof recorded !== 'string') {
    throw new Error('Missing committed recording identity.');
  }
  return recorded;
})();

function projector(): CommittedAssistantLogProjection {
  return new CommittedAssistantLogProjection({
    // Test-owned resolver, as in the projection suite: no production alias.
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-16T03:18:00.000Z'),
      parentMessageId: null,
    }),
    threadId: rows[0]?.threadId ?? '',
  });
}

function answer(projection: CommittedAssistantLogProjection) {
  const message = projection
    .getSnapshot()
    .repository.messages.find(({ message: item }) => item.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing projected recorded answer.');
  }
  return message;
}

describe('a provider that streams its tool input incrementally', () => {
  it('projects the empty opening delta, the call, its result and the finished run', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const content = answer(projection).content;
    const tool = content.find((part) => part.type === 'tool-call');
    expect(tool).toMatchObject({
      args: { path: 'README.md' },
      argsText: '{"path":"README.md"}',
      result: { content: 'hello', path: 'README.md' },
      toolCallId: 'call_incremental_1',
    });
    // The step's reasoning and text precede its call, in the model's order.
    expect(content.filter((part) => part.type !== 'data').map((part) => part.type)).toEqual([
      'reasoning',
      'text',
      'tool-call',
      'text',
    ]);
    expect(projection.getSnapshot()).toMatchObject({ activeRunId: undefined, isRunning: false });
    expect(answer(projection).status).toEqual({ reason: 'stop', type: 'complete' });
  });

  it('grows the call from its live input deltas until its committed call replaces them', () => {
    const projection = projector();
    const opened = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as Record<string, unknown>)['type'] === 'tool-input-start'
    );
    projection.acceptCommitted(rows.slice(0, opened + 1));
    const call = () => answer(projection).content.find((part) => part.type === 'tool-call');
    // The deltas the recorded provider streamed, as uncommitted telemetry: the
    // empty opening delta first (the wire's `arguments: ""`).
    projection.acceptLive(runId, { delta: '', id: 'call_incremental_1', type: 'tool-input-delta' });
    expect(call()).toMatchObject({ args: {}, argsText: '', toolName: 'read_fixture' });
    projection.acceptLive(runId, {
      delta: '{',
      id: 'call_incremental_1',
      type: 'tool-input-delta',
    });
    projection.acceptLive(runId, {
      delta: '"path":"README',
      id: 'call_incremental_1',
      type: 'tool-input-delta',
    });
    expect(call()).toMatchObject({ args: { path: 'README' }, argsText: '{"path":"README' });
    expect(projection.getSnapshot()).toMatchObject({ activeRunId: runId, isRunning: true });

    projection.acceptCommitted(rows);
    expect(call()).toMatchObject({ args: { path: 'README.md' }, argsText: '{"path":"README.md"}' });
    // A delta that arrives after the committed call no longer changes it.
    projection.acceptLive(runId, {
      delta: 'x',
      id: 'call_incremental_1',
      type: 'tool-input-delta',
    });
    expect(call()).toMatchObject({ argsText: '{"path":"README.md"}' });
  });

  it('keeps the committed input when replayed deltas arrive before the call runs', () => {
    const projection = projector();
    const committed = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as Record<string, unknown>)['type'] === 'tool-call'
    );
    projection.acceptCommitted(rows.slice(0, committed + 1));
    const call = () => answer(projection).content.find((part) => part.type === 'tool-call');
    expect(call()).toMatchObject({ argsText: '{"path":"README.md"}' });
    // A view that subscribes now replays the step's telemetry, deltas included.
    for (const delta of ['', '{', '"path":"README.md"}']) {
      projection.acceptLive(runId, { delta, id: 'call_incremental_1', type: 'tool-input-delta' });
    }
    expect(call()).toMatchObject({ args: { path: 'README.md' }, argsText: '{"path":"README.md"}' });
    expect(projection.getSnapshot()).toMatchObject({ activeRunId: runId, isRunning: true });
  });
});
