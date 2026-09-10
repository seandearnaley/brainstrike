import { expect, it, vi } from 'vitest';
import type { MastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createTurnAttemptLifecycleState,
  runTurnAttempts,
  type TurnAttempt,
} from '../mastra/turn-attempts';
import { StreamStalledError } from '../stream/with-inactivity-timeout';
import type { StreamChunk } from '../types';

it('joins aborted child saves before a watchdog continuation and disposes after finalization', async () => {
  const order: string[] = [];
  const childStarted = Promise.withResolvers<void>();
  const childSaved = Promise.withResolvers<void>();
  const rootFinalizer = vi.fn(async () => undefined);
  const lifecycleState = createTurnAttemptLifecycleState(undefined, undefined, undefined);
  const firstAttempt: TurnAttempt = {
    abortedTurnPersistence: undefined,
    chunks: (async function* () {
      yield { type: 'text-delta', value: 'Partial output' } satisfies StreamChunk;
      throw new StreamStalledError(100, { partsSeen: 1, phase: 'streaming' });
    })(),
    lifecycleState,
    readProducedMessages: () => [],
  };
  const runtime = {
    delegatedTurnPersistence: {
      finalize: async () => {
        childStarted.resolve();
        await childSaved.promise;
        order.push('child finalized');
      },
    },
    dispose: async () => {
      order.push('disposed');
    },
  } as unknown as MastraAgentRuntime;
  const continuation = vi.fn(async (): Promise<TurnAttempt> => {
    order.push('continuation');
    return {
      abortedTurnPersistence: {
        attachMessageList: () => undefined,
        captureSnapshot: () => undefined,
        finalize: rootFinalizer,
        markNormalFinish: () => undefined,
      },
      chunks: (async function* () {
        yield { type: 'text-delta', value: 'Recovered' } satisfies StreamChunk;
      })(),
      lifecycleState,
      readProducedMessages: () => [],
    };
  });
  const chunks: StreamChunk[] = [];
  const consume = (async () => {
    for await (const chunk of runTurnAttempts({
      firstAttempt,
      makeContinuation: continuation,
      maxAttempts: 2,
      preludeChunks: [],
      runtime,
      runtimeData: undefined,
    })) {
      chunks.push(chunk);
    }
  })();
  await childStarted.promise;
  expect(continuation).not.toHaveBeenCalled();
  childSaved.resolve();
  await consume;
  expect(chunks).toContainEqual({ type: 'text-delta', value: 'Recovered' });
  expect(order).toEqual(['child finalized', 'continuation', 'child finalized', 'disposed']);
  expect(rootFinalizer).toHaveBeenCalledTimes(1);
});
