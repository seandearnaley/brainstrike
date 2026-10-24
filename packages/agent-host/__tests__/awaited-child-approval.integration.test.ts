/**
 * An awaited delegation holds its parent's tool call open until the child
 * settles. The parent's watchdog judges only its own model calls and the child
 * is judged by its own run, so a child that works or waits on a person for
 * longer than any parent window is still a healthy turn.
 */
import { randomUUID } from 'node:crypto';
import { resolveAssistantResilienceConfig } from '@brainstrike/agent/provider-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HostEvent } from '../src/protocol.js';
import {
  type Chunk,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  // Only the host's timers jump; the store and the polls keep real time.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'CHILD_TASK: write the notes.';
const windows = resolveAssistantResilienceConfig();
/** Longer than every window the parent's watchdog has. */
const PAST_EVERY_WINDOW_MS =
  Math.max(windows.streamFirstOutputMs, windows.streamReasoningGapMs, windows.streamInactivityMs) +
  60_000;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

type Streamed = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;

/** The root awaits one worker; `child` answers the child's provider calls. */
function awaitingModel(child: (answered: boolean) => Streamed) {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const answered = call.prompt.some((message) => message.role === 'tool');
      if (userTexts(call).some((input) => input.includes(TASK))) {
        return child(answered);
      }
      if (!toolNames(call).includes('agent-worker') || answered) {
        return stream(text('Parent continues.'));
      }
      return stream(
        toolCall(
          'agent-worker',
          { _background: { disposition: 'awaited', enabled: true }, prompt: TASK },
          'delegate-1'
        )
      );
    },
  });
}

/** An answer that keeps streaming, one delta every `gapMs`, well inside the child's own windows. */
function slowAnswer(deltas: number, gapMs: number): Streamed {
  return {
    stream: new ReadableStream<Chunk>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ id: 'text-1', type: 'text-start' });
        for (let index = 0; index < deltas; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          controller.enqueue({ delta: `part ${index}. `, id: 'text-1', type: 'text-delta' });
        }
        controller.enqueue({ id: 'text-1', type: 'text-end' });
        controller.enqueue({
          finishReason: { raw: 'stop', unified: 'stop' },
          type: 'finish',
          usage,
        });
        controller.close();
      },
    }),
  };
}

const askingPolicy = () => ({
  policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' as const, read: 'allow' as const },
  yolo: false,
});

test('a root awaiting a child that waits on an approval outlives every parent window', async () => {
  const model = awaitingModel((answered) =>
    stream(
      answered ? text('Child wrote.') : toolCall('write_file', { path: 'notes.md' }, 'write-1')
    )
  );
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [worker],
    policy: askingPolicy,
  });
  const rootRunId = await harness.start('Delegate.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  const [childThreadId = ''] = await childThreads(harness);
  const childRows = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'interaction.requested',
    15_000
  );
  const approval = childRows
    .map((row) => row.event)
    .find(
      (event): event is Extract<HostEvent, { type: 'interaction.requested' }> =>
        event.type === 'interaction.requested'
    );
  if (!approval) {
    throw new Error('Expected the child to ask for approval');
  }

  // The person takes longer than any parent window to answer.
  await vi.advanceTimersByTimeAsync(PAST_EVERY_WINDOW_MS);
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: approval.interactionId,
    runId: approval.runId,
    threadId: childThreadId,
  });
  const rows = await rowsUntil(
    harness,
    harness.threadId,
    finished(rootRunId),
    getAdjustedTimeout('integration')
  );
  expect(rows.find(finished(rootRunId))?.event).toMatchObject({ outcome: 'completed' });
  expect(harness.writes).toEqual([JSON.stringify({ path: 'notes.md' })]);
});

test('a root awaiting a child that keeps working past every parent window completes', async () => {
  const gapMs = 100_000;
  const deltas = Math.ceil(PAST_EVERY_WINDOW_MS / gapMs);
  const model = awaitingModel(() => slowAnswer(deltas, gapMs));
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [worker],
    policy: askingPolicy,
  });
  const rootRunId = await harness.start('Delegate.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  for (let index = 0; index <= deltas; index += 1) {
    await vi.advanceTimersByTimeAsync(gapMs);
  }
  const rows = await rowsUntil(
    harness,
    harness.threadId,
    finished(rootRunId),
    getAdjustedTimeout('integration')
  );
  const [childThreadId = ''] = await childThreads(harness);
  const childRows = await harness.core().read(childThreadId, 0);
  expect(childRows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(rows.find(finished(rootRunId))?.event).toMatchObject({ outcome: 'completed' });
});
