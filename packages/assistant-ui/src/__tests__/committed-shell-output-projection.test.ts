// @vitest-environment node
import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;

/**
 * A host command's live output is uncommitted telemetry (ADR-0011 amendment);
 * the tool result owns the output. A `stream.chunk` carrying a shell slice can
 * only come from a log written before that, and a reload presents no live
 * output from it, as legacy did.
 */
it('presents no live output from a shell slice an older log committed', () => {
  const start = rows.find(({ event }) => event['type'] === 'run.started');
  const requested = rows.findIndex(({ event }) => event['type'] === 'interaction.requested');
  const pause = rows[requested];
  const runId = start?.event['runId'];
  const toolCallId = pause?.event['toolCallId'];
  if (!(start && pause && typeof runId === 'string' && typeof toolCallId === 'string')) {
    throw new Error('Missing the recorded run and its tool call.');
  }
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: 'recorded-prompt',
    }),
    threadId: start.threadId,
  });
  projection.acceptCommitted(rows.slice(0, requested + 1));
  projection.acceptCommitted([
    {
      ...pause,
      event: {
        chunk: {
          chunk: 'STREAM_STDOUT_FIRST',
          stream: 'stdout',
          toolCallId,
          type: 'brainstrike.shell-output.chunk',
        },
        runId,
        type: 'stream.chunk',
      },
      seq: pause.seq + 1,
    },
  ]);
  const answer = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  expect(
    answer?.content.filter((part) => part.type === 'data' && part.name === SHELL_OUTPUT_DATA_NAME)
  ).toEqual([]);
});
