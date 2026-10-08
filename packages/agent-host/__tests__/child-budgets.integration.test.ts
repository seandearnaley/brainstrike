/**
 * BST-1932 S2b: tree-wide limits from the user's subagent settings. One FIFO
 * work queue per root turn (C4), the per-turn invocation budget (AT-27), a
 * child's reserved summary step and output caps (C9-C15), and the child
 * execution deadline (G19, AT-26).
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { CHILD_WRAP_UP_FEEDBACK } from '../src/child-runs.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolCalls,
  toolResults,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
const lastUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call).at(-1) ?? '';
const isParent = (call: Pick<CallOptions, 'tools'>): boolean =>
  (call.tools ?? []).some((tool) => tool.name === 'agent-explore');
const runsOf = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

async function settledChildren(harness: ChildRunHarness, count: number): Promise<string[]> {
  let threads: string[] = [];
  await expect
    .poll(async () => {
      threads = await childThreads(harness);
      const done = await Promise.all(
        threads.map(async (threadId) =>
          (await harness.core().read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
      );
      return threads.length === count && done.every(Boolean);
    })
    .toBe(true);
  return threads;
}

test('every model step of the turn’s children queues FIFO on maxConcurrentWork; the root is not queued', async () => {
  let active = 0;
  let maxActive = 0;
  const gates: PromiseWithResolvers<void>[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (isParent(call)) {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent read both outcomes.'));
        }
        return stream(
          call.prompt.some((message) => message.role === 'tool')
            ? text('Parent continues.')
            : toolCalls([
                ['agent-explore', { prompt: 'ALPHA_TASK' }, 'fan-1'],
                ['agent-explore', { prompt: 'BETA_TASK' }, 'fan-2'],
              ])
        );
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return stream(text(`${lastUser(call)} done.`));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, { maxConcurrentWork: 1 });
  const runId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  await expect.poll(() => gates.length).toBe(1);
  // The second child's step waits in the queue: no provider call until a permit frees.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(gates).toHaveLength(1);
  gates[0]?.resolve();
  await expect.poll(() => gates.length).toBe(2);
  gates[1]?.resolve();
  await settledChildren(harness, 2);
  expect(maxActive).toBe(1);
});

test('the turn’s invocation budget refuses an extra delegation with the shipped text and no child', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (isParent(call)) {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent read the outcome.'));
        }
        return stream(
          call.prompt.some((message) => message.role === 'tool')
            ? text('Parent continues.')
            : toolCalls([
                ['agent-explore', { prompt: 'ALPHA_TASK' }, 'fan-1'],
                ['agent-explore', { prompt: 'BETA_TASK' }, 'fan-2'],
              ])
        );
      }
      return stream(text(`${lastUser(call)} done.`));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, { maxInvocations: 1 });
  const runId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  await settledChildren(harness, 1);
  const parentSecond = model.doStreamCalls.find(
    (call) => isParent(call) && lastUser(call) === 'Fan out.' && toolResults(call).length > 0
  ) as CallOptions;
  const results = JSON.stringify(toolResults(parentSecond));
  expect(results).toContain(
    '[Delegation Rejected] Delegation invocation limit reached (1 per original turn).'
  );
  expect(results).toContain('Background task started.');
  // The refused call is no invocation: the wake ledger lists only the child that ran.
  const rows = await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some((started) => started.delivery?.via === 'wake')
  );
  const wake = runsOf(rows).find((started) => started.delivery?.via === 'wake');
  expect(wake?.prompt).toContain(`${LEDGER} — 1 total: 1 returned`);
});

test('a child’s last step is a tool-free summary, and every step is capped by the user’s token settings', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (isParent(call)) {
        return stream(
          call.prompt.some((message) => message.role === 'tool')
            ? text('Parent consumed the summary.')
            : toolCall(
                'agent-explore',
                { _background: { enabled: false }, prompt: 'SURVEY_TASK' },
                'fg-1'
              )
        );
      }
      // The child keeps exploring; only the reserved step can end it.
      return (call.tools ?? []).length > 0
        ? stream(toolCall('read_file', { path: 'notes.txt' }, `read-${model.doStreamCalls.length}`))
        : stream(text('Summary of what I found.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    maxChildSteps: 3,
    maxStepOutputTokens: 512,
    synthesisOutputTokens: 256,
  });
  const runId = await harness.start('Delegate a survey.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const childCalls = model.doStreamCalls.filter((call) => !isParent(call));
  expect(childCalls).toHaveLength(3);
  expect(childCalls.map((call) => call.maxOutputTokens)).toEqual([512, 512, 256]);
  expect((childCalls[0]?.tools ?? []).map((tool) => tool.name)).toEqual(['read_file']);
  const summary = childCalls[2] as CallOptions;
  expect(summary.tools ?? []).toEqual([]);
  expect(summary.toolChoice).toEqual({ type: 'none' });
  expect(lastUser(summary)).toBe(CHILD_WRAP_UP_FEEDBACK);
  const parentLast = model.doStreamCalls.at(-1) as CallOptions;
  expect(JSON.stringify(toolResults(parentLast))).toContain('Summary of what I found.');
});

test('an expired child deadline fails that child alone; its siblings complete', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (isParent(call)) {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent read the outcomes.'));
        }
        return stream(
          call.prompt.some((message) => message.role === 'tool')
            ? text('Parent continues.')
            : toolCalls([
                ['agent-explore', { prompt: 'SLOW_TASK' }, 'fan-1'],
                ['agent-explore', { prompt: 'QUICK_TASK' }, 'fan-2'],
              ])
        );
      }
      return lastUser(call) === 'SLOW_TASK' ? blocked(call) : stream(text('Quick done.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    maxChildRuntimeMs: 1000,
  });
  const runId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const threads = await settledChildren(harness, 2);
  const outcomes = await Promise.all(
    threads.map(
      async (threadId) =>
        (await harness.core().read(threadId, 0)).find((row) => row.event.type === 'run.finished')
          ?.event
    )
  );
  expect(outcomes).toContainEqual(
    expect.objectContaining({ detail: 'Task timed out after 1000ms', outcome: 'failed' })
  );
  expect(outcomes).toContainEqual(expect.objectContaining({ outcome: 'completed' }));
  // The quick sibling may wake the parent first; the expired child is in a later batch.
  await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some(
      (started) =>
        started.delivery?.via === 'wake' &&
        started.prompt.includes('failed — Task timed out after 1000ms')
    )
  );
});
