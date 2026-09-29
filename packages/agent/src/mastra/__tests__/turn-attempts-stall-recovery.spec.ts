import { expect, it, vi } from 'vitest';
import { StreamStalledError } from '../../stream/with-inactivity-timeout';
import type { StreamChunk } from '../../types';
import type { MastraAgentRuntime } from '../agent-runtime';
import {
  createTurnAttemptLifecycleState,
  runTurnAttempts,
  type TurnAttempt,
} from '../turn-attempts';

/**
 * BST-1407/1409 recovers a stalled ATTEMPT by re-sending the prompt to a
 * continuation. That is safe for a stall mid-generation ('streaming'), which
 * simply restarts the model. It is NOT safe for a stall mid tool execution
 * ('tool-executing'): resuming re-sends the step, which would launch a SECOND
 * execution of a tool whose first process may still be running. A
 * 'tool-executing' stall must therefore spend exactly one attempt and end the
 * turn, never reaching the continuation.
 */
function makeRuntime(dispose: () => Promise<void>): MastraAgentRuntime {
  return {
    delegatedTurnPersistence: undefined,
    dispose,
  } as unknown as MastraAgentRuntime;
}

function makeStallingAttempt(error: StreamStalledError): TurnAttempt {
  const lifecycleState = createTurnAttemptLifecycleState(undefined, undefined, undefined);
  return {
    abortedTurnPersistence: undefined,
    chunks: (async function* () {
      yield { type: 'text-delta', value: 'partial' } satisfies StreamChunk;
      throw error;
    })(),
    lifecycleState,
    readProducedMessages: () => [],
    settleNativeStream: async () => undefined,
  };
}

it('is terminal after one attempt on a tool-executing stall, even with budget left', async () => {
  const continuation = vi.fn();
  const chunks: StreamChunk[] = [];
  for await (const chunk of runTurnAttempts({
    firstAttempt: makeStallingAttempt(
      new StreamStalledError(635_000, {
        lastPartType: 'tool-call',
        partsSeen: 4,
        phase: 'tool-executing',
      })
    ),
    makeContinuation: continuation,
    maxAttempts: 3,
    preludeChunks: [],
    runtime: makeRuntime(async () => undefined),
    runtimeData: undefined,
  })) {
    chunks.push(chunk);
  }
  expect(continuation).not.toHaveBeenCalled();
  expect(
    chunks.some((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed')
  ).toBe(true);
});

it('still recovers a streaming stall within the attempt budget', async () => {
  const continuation = vi.fn(async (): Promise<TurnAttempt> => {
    const lifecycleState = createTurnAttemptLifecycleState(undefined, undefined, undefined);
    return {
      abortedTurnPersistence: undefined,
      chunks: (async function* () {
        yield { type: 'text-delta', value: 'recovered' } satisfies StreamChunk;
      })(),
      lifecycleState,
      readProducedMessages: () => [],
      settleNativeStream: async () => undefined,
    };
  });
  const chunks: StreamChunk[] = [];
  for await (const chunk of runTurnAttempts({
    firstAttempt: makeStallingAttempt(
      new StreamStalledError(600_000, {
        lastPartType: 'text-delta',
        partsSeen: 4,
        phase: 'streaming',
      })
    ),
    makeContinuation: continuation,
    maxAttempts: 3,
    preludeChunks: [],
    runtime: makeRuntime(async () => undefined),
    runtimeData: undefined,
  })) {
    chunks.push(chunk);
  }
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(chunks).toContainEqual({ type: 'text-delta', value: 'recovered' });
});
