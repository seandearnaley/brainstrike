import {
  type AssistantResilienceConfig,
  StreamStalledError,
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

// The tool backstop is derived in production (minutes); a unit window keeps
// the phase choice observable. Every window is distinct, and the fake clock
// pins which one expires: the stream is still open one millisecond before it.
const config: AssistantResilienceConfig = {
  streamFirstOutputMs: 2000,
  streamInactivityMs: 300,
  streamReasoningGapMs: 2000,
  streamStallAttempts: 2,
  toolCallInputMs: 2000,
  toolExecutingMs: 2000,
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

const toolCall = (providerExecuted: boolean): Part =>
  ({
    input: { text: 'look' },
    toolCallId: 'call-1',
    toolName: 'probe',
    type: 'tool-call',
    ...(providerExecuted ? { providerExecuted: true } : {}),
  }) as Part;

async function drain(
  parts: readonly Part[]
): Promise<{ readonly error: unknown; readonly expired: HostStreamWatchdogError[] }> {
  const expired: HostStreamWatchdogError[] = [];
  try {
    for await (const _part of watchHostStream(
      source(parts),
      config,
      (name) => name === 'probe',
      (error) => expired.push(error)
    )) {
      // Consume like Core does.
    }
  } catch (error) {
    return { error, expired };
  }
  throw new Error('A silent stream must not end without a watchdog expiry');
}

/** Drains on the fake clock: the stream survives `windowMs - 1` of silence and expires at `windowMs`. */
async function drainUntilExpiry(
  windowMs: number,
  parts: readonly Part[]
): ReturnType<typeof drain> {
  let settled = false;
  const drained = drain(parts).finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(windowMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  return drained;
}

test('a running host tool is measured against the tool backstop, not the answer window', async () => {
  const { error, expired } = await drainUntilExpiry(2000, [{ type: 'start' }, toolCall(false)]);
  expect(error).toBeInstanceOf(StreamStalledError);
  expect(error).toMatchObject({
    inactivityMs: 2000,
    lastPartType: 'tool-call',
    phase: 'tool-executing',
  });
  expect(expired).toEqual([error]);
});

test('a provider-executed tool call stays on the provider answer window', async () => {
  const { error } = await drainUntilExpiry(300, [{ type: 'start' }, toolCall(true)]);
  expect(error).toMatchObject({ inactivityMs: 300, phase: 'streaming' });
});

test('an approval request settles the call: the wait is on a human, not the tool', async () => {
  const { error } = await drainUntilExpiry(300, [
    { type: 'start' },
    toolCall(false),
    {
      approvalId: 'approval-1',
      toolCall: toolCall(false),
      type: 'tool-approval-request',
    } as Part,
  ]);
  expect(error).toMatchObject({ phase: 'streaming' });
});

test('a call the host approves in-stream runs on the tool backstop again', async () => {
  // The recorded host shape for an allowed tool: request and approved response
  // arrive together, then the SDK executes the call.
  const { error } = await drainUntilExpiry(2000, [
    { type: 'start' },
    toolCall(false),
    { approvalId: 'approval-1', toolCall: toolCall(false), type: 'tool-approval-request' } as Part,
    {
      approvalId: 'approval-1',
      approved: true,
      toolCall: toolCall(false),
      type: 'tool-approval-response',
    } as Part,
  ]);
  expect(error).toMatchObject({ inactivityMs: 2000, phase: 'tool-executing' });
});

test('expiry stops the provider attempt, and a tool-executing stall also cancels the run', () => {
  const attempt = new AbortController();
  const run = { controller: new AbortController(), id: 'run-1', threadId: 'thread-1' };
  const streaming = new StreamStalledError(300, { partsSeen: 2, phase: 'streaming' });
  stopHostStreamAttempt(run as HostRunState, attempt, streaming);
  expect(attempt.signal.reason).toBe(streaming);
  expect(run.controller.signal.aborted).toBe(false);

  const tool = new StreamStalledError(2000, { partsSeen: 2, phase: 'tool-executing' });
  stopHostStreamAttempt(run as HostRunState, new AbortController(), tool);
  expect(run.controller.signal.reason).toBe(tool);
});
