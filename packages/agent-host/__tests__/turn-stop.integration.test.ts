/**
 * A turn is one committed id, and a turn Stop ends all of it. The composer's
 * Stop names the turn's first run, which has often ended by then; the wake
 * carrying the turn on and a worker committed as the person clicks are the
 * same turn, so they end too. A wake belongs to the turn it follows, never a
 * worker's follow-up (audit SC-2, SC-4, D-6).
 */
import { randomUUID } from 'node:crypto';
import type { AppendItem } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
/** The parent's first step, before any tool result. */
const delegating = (call: CallOptions) => !call.prompt.some((message) => message.role === 'tool');

async function quiet(harness: ChildRunHarness, threadId = harness.threadId): Promise<HostLogRow[]> {
  await harness.core().idle(harness.threadId);
  return harness.core().read(threadId, 0);
}
const outcomes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []));
/** The thread's wakes: each run's ID and the delivery it answers. */
const wakes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) =>
    event.type === 'run.started' && event.delivery?.via === 'wake'
      ? [{ delivery: event.delivery, runId: event.runId }]
      : []
  );

test('a turn Stop ends the wake that carries the turn on', async () => {
  const waking = Promise.withResolvers<void>();
  // The worker reports once the turn's last step has begun, so a wake carries the turn on.
  const lastStep = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        await lastStep.promise;
        return stream(text('Worker outcome.'));
      }
      if (userTexts(call).some((input) => input.includes(LEDGER))) {
        waking.resolve();
        return blocked(call);
      }
      if (delegating(call)) {
        return stream(toolCall('agent-explore', { prompt: 'Look.' }, 'bg-1'));
      }
      lastStep.resolve();
      return stream(text('Parent continues.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const turn = await harness.start('Delegate.');
  await waking.promise;

  // The composer names the turn's first run, which ended before the wake began.
  const { outcome } = await harness
    .core()
    .stop({ commandId: randomUUID(), runId: turn, threadId: harness.threadId });

  expect(outcome).toBe('already-terminal');
  const rows = await quiet(harness);
  expect(wakes(rows)).toHaveLength(1);
  expect(outcomes(rows)).toEqual(['completed', 'stopped']);
});

test('a worker committed as its turn stops ends stopped, never left running', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) =>
      toolNames(call).includes('agent-explore') && delegating(call)
        ? stream(toolCall('agent-explore', { prompt: 'Look.' }, 'bg-1'))
        : blocked(call),
  });
  const delegated = Promise.withResolvers<void>();
  const stopCommitted = Promise.withResolvers<void>();
  const isOrigin = (item: AppendItem) =>
    item.event.type === 'thread.started' && 'origin' in item.event;
  const isStop = (item: AppendItem) =>
    item.event.type === 'command.accepted' && item.event['method'] === 'run/stop';
  const harness = await setupChildRunHost(model, cleanup, {
    holdAppend: async (items) => {
      if (items.some(isStop)) {
        stopCommitted.resolve();
      }
      if (items.some(isOrigin)) {
        // The worker's commit lands only after the turn's Stop committed.
        delegated.resolve();
        await stopCommitted.promise;
      }
    },
  });
  const turn = await harness.start('Delegate.');
  await delegated.promise;

  await harness.core().stop({ commandId: randomUUID(), runId: turn, threadId: harness.threadId });

  const [child = ''] = await childThreads(harness);
  expect(outcomes(await quiet(harness, child))).toEqual(['stopped']);
  expect(outcomes(await quiet(harness))).toEqual(['stopped']);
});

async function followUpHost() {
  // The worker reports once the turn's last step has begun, so a wake delivers it.
  const lastStep = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        await lastStep.promise;
        return stream(text('Worker outcome.'));
      }
      if (userTexts(call).at(-1) === 'Delegate.' && delegating(call)) {
        return stream(toolCall('agent-explore', { prompt: 'Look.' }, 'bg-1'));
      }
      lastStep.resolve();
      return stream(text('Parent continues.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const turn = await harness.start('Delegate.');
  const [first] = wakes(await quiet(harness));
  const [child = ''] = await childThreads(harness);
  /** The person types into the idle worker; its reply reports to the parent. */
  const followUp = async () => {
    const { runId } = await harness.core().startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'One more look.',
      threadId: child,
    });
    const [, second] = wakes(await quiet(harness));
    expect(second?.delivery.entries.map((entry) => entry.childRunId)).toEqual([runId]);
    return second;
  };
  return { first, followUp, harness, turn };
}

test("a worker's follow-up wakes its parent in the parent's turn, not the worker's", async () => {
  const { first, followUp } = await followUpHost();
  const second = await followUp();
  expect(second?.delivery.turnId).toBe(first?.delivery.turnId);
});

test("a follow-up after the parent's turn stopped wakes it in a turn of its own", async () => {
  const { followUp, harness, turn } = await followUpHost();
  await harness.core().stop({ commandId: randomUUID(), runId: turn, threadId: harness.threadId });
  const second = await followUp();
  expect(second?.delivery.turnId).toBe(second?.runId);
});
