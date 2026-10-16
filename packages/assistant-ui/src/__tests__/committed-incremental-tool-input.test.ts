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

  it('shows the call with no input yet while only its empty opening delta has committed', () => {
    const projection = projector();
    const opening = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as Record<string, unknown>)['type'] === 'tool-input-delta'
    );
    projection.acceptCommitted(rows.slice(0, opening + 1));
    expect(answer(projection).content.find((part) => part.type === 'tool-call')).toMatchObject({
      toolCallId: 'call_incremental_1',
      toolName: 'read_fixture',
    });
    expect(projection.getSnapshot()).toMatchObject({ activeRunId: runId, isRunning: true });
  });
});
