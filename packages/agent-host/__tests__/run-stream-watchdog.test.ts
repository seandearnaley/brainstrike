import {
  type AssistantResilienceConfig,
  StreamStalledError,
  ToolExecutions,
} from '@brainstrike/agent/provider-runtime';
import type { TextStreamPart, ToolSet } from 'ai';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HostRunState } from '../src/core-state.js';
import {
  type HostStreamWatchdogError,
  stopHostStreamAttempt,
  watchHostStream,
} from '../src/run-stream-watchdog.js';

type Part = TextStreamPart<ToolSet>;

// Every window is distinct, and the fake clock pins which one expires: the
// stream is still open one millisecond before it.
const config: AssistantResilienceConfig = {
  streamFirstOutputMs: 2600,
  streamInactivityMs: 300,
  streamReasoningGapMs: 2400,
  streamStallAttempts: 2,
  toolCallInputMs: 2200,
  toolTimeoutMs: 1000,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** AI SDK 7 `fullStream` parts, then silence until the consumer stops reading. */
async function* source(parts: readonly Part[]): AsyncGenerator<Part> {
  yield* parts;
  await new Promise<never>(() => undefined);
}

const toolCall: Part = {
  input: { text: 'look' },
  toolCallId: 'call-1',
  toolName: 'probe',
  type: 'tool-call',
} as Part;

function drain(
  parts: readonly Part[],
  toolExecutions: ToolExecutions
): {
  readonly drained: Promise<{
    readonly error: unknown;
    readonly expired: HostStreamWatchdogError[];
  }>;
  readonly settled: () => boolean;
} {
  const expired: HostStreamWatchdogError[] = [];
  let settled = false;
  const drained = (async () => {
    try {
      for await (const _part of watchHostStream(source(parts), config, toolExecutions, (error) =>
        expired.push(error)
      )) {
        // Consume like Core does.
      }
    } catch (error) {
      return { error, expired };
    } finally {
      settled = true;
    }
    throw new Error('A silent stream must not end without a watchdog expiry');
  })();
  return { drained, settled: () => settled };
}

test('a provider that goes quiet after a tool call, before the tool runs, stalls on the answer window', async () => {
  const { drained, settled } = drain([{ type: 'start' }, toolCall], new ToolExecutions());
  await vi.advanceTimersByTimeAsync(config.streamInactivityMs - 1);
  expect(settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  const { error, expired } = await drained;
  expect(error).toBeInstanceOf(StreamStalledError);
  expect(error).toMatchObject({
    inactivityMs: config.streamInactivityMs,
    lastPartType: 'tool-call',
    phase: 'streaming',
  });
  expect(expired).toEqual([error]);
});

test('a running tool is never judged by the stream watchdog', async () => {
  const toolExecutions = new ToolExecutions();
  const { settled } = drain([{ type: 'start' }, toolCall], toolExecutions);
  await vi.advanceTimersByTimeAsync(0);
  toolExecutions.start('call-1');
  await vi.advanceTimersByTimeAsync(100 * config.streamFirstOutputMs);
  expect(settled()).toBe(false);
});

test('expiry stops the provider attempt, never the run', () => {
  const attempt = new AbortController();
  const run = { controller: new AbortController(), id: 'run-1', threadId: 'thread-1' };
  const stall = new StreamStalledError(300, { partsSeen: 2, phase: 'streaming' });
  stopHostStreamAttempt(run as HostRunState, attempt, stall);
  expect(attempt.signal.reason).toBe(stall);
  expect(run.controller.signal.aborted).toBe(false);
});
