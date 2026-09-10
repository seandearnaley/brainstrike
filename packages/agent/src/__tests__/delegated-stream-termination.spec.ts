import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { describe, expect, it } from 'vitest';
import { processMastraStreamPart } from '../mastra/agent-streaming';
import { makeDelegatedStreamTermination } from '../mastra/stream-termination';
import { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';
import { DataStreamMapper } from '../stream/data-stream-mapper';

describe('interrupted child tool presentation', () => {
  it.each([true, false])(
    'settles the decoded tool and durable lifecycle once (cancelled=%s)',
    async (cancelled) => {
      const state = createTurnAttemptLifecycleState(undefined, undefined, undefined);
      const started = await processMastraStreamPart(
        {
          payload: { args: { path: 'file' }, toolCallId: 'active-call', toolName: 'read' },
          type: 'tool-call',
        },
        new Map(),
        state
      );
      const terminal = makeDelegatedStreamTermination(state, cancelled);
      expect(
        terminal.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.failed')
      ).toMatchObject([
        {
          event: {
            metadata: { toolCallId: 'active-call' },
            status: cancelled ? 'cancelled' : 'failed',
          },
        },
      ]);
      expect(
        makeDelegatedStreamTermination(state, cancelled).filter(
          (chunk) => chunk.type === 'tool-event'
        )
      ).toEqual([]);
      const mapper = new DataStreamMapper('native-child-message');
      const frames = [
        ...mapper.initialChunks(),
        ...[...started.chunks, ...terminal].flatMap((chunk) => [...mapper.handleChunk(chunk)]),
      ];
      const response = new Response(
        frames.map((frame) => `${frame.code}:${JSON.stringify(frame.value)}\n`).join('')
      );
      if (!response.body) {
        throw new Error('Missing decoder input');
      }
      let decoded: AssistantMessage | undefined;
      for await (const message of response.body
        .pipeThrough(new DataStreamDecoder())
        .pipeThrough(new AssistantMessageAccumulator())) {
        decoded = message;
      }
      expect(decoded?.parts).toContainEqual(
        expect.objectContaining({
          isError: true,
          result: expect.any(String),
          toolCallId: 'active-call',
          type: 'tool-call',
        })
      );
      // The normal decoder marks abnormal finishes incomplete. The persisted
      // run/tool events above retain the separate cancelled versus failed outcome.
      expect(decoded?.status).toMatchObject({ reason: 'error', type: 'incomplete' });
    }
  );
});
