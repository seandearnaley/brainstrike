import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import { expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;

/**
 * BST-1932 (AT-07): a host command streams its output through the tool's Mastra
 * writer, whose `custom` commits the chunk verbatim as a `stream.chunk` row
 * (`writeShellOutputChunk` → `ToolStream.custom` → the host's `write`). The
 * projection presents it as the shell-output data part a tool card streams.
 */
it('presents a committed host shell-output chunk as its tool call’s live output', () => {
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
  ).toEqual([
    expect.objectContaining({
      data: { chunk: 'STREAM_STDOUT_FIRST', stream: 'stdout', toolCallId },
      name: SHELL_OUTPUT_DATA_NAME,
    }),
  ]);
});
