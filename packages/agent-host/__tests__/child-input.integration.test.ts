/**
 * BST-1932 (AT-09, approved Option C): human input typed into a RUNNING child.
 * The host ends the child's active run after its step in flight and starts the
 * input as the child's next run, through the ordinary run admission. Only that
 * run's end reports to the parent, in one wake. A root thread queues its next
 * message instead, and a settled child takes a follow-up run/start.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  type CallOptions,
  childThreads,
  finished,
  rowsUntil,
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

const TASK = 'INPUT_TASK: read the notes.';
const INPUT = 'HUMAN_INPUT_7: check the date too.';
const LEDGER = 'Background invocations of this turn';
const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const finishedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event] : []));

function inputModel() {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (toolNames(call).includes('agent-explore')) {
        if (user.includes(LEDGER)) {
          return stream(text('Parent read the child.'));
        }
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent continues.'))
          : stream(toolCall('agent-explore', { prompt: TASK }, 'input-1'));
      }
      if (user.includes(INPUT)) {
        return stream(text('Child read the input.'));
      }
      return call.prompt.some((message) => message.role === 'tool')
        ? stream(text('Child missed the input.'))
        : stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
    },
  });
}

test('a running child ends after its step in flight, and the input runs next and reports once', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const [active] = startedRuns(await harness.core().read(childThreadId, 0));
  try {
    await expect(
      harness.core().input({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: INPUT,
        runId: active?.runId ?? '',
        threadId: childThreadId,
      })
    ).resolves.toEqual({ accepted: true });
  } finally {
    release.resolve();
  }

  // The input's run follows the active run, which ended after its tool result.
  const child = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== active?.runId,
    5000
  );
  const runs = startedRuns(child);
  expect(runs).toHaveLength(2);
  expect(finishedRuns(child).map(({ outcome }) => outcome)).toEqual(['completed', 'completed']);
  const childCalls = model.doStreamCalls.filter(
    (call) => !toolNames(call).includes('agent-explore')
  );
  expect(childCalls).toHaveLength(2);
  const answered = childCalls[1] as CallOptions;
  expect(answered.prompt.map((message) => message.role).slice(-3)).toEqual([
    'assistant',
    'tool',
    'user',
  ]);
  expect(userTexts(answered).at(-1)).toBe(INPUT);

  // One wake, after the input's run: the parent reads the answer the input produced.
  const parent = await rowsUntil(
    harness,
    harness.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== rootRunId,
    5000
  );
  const wakes = startedRuns(parent).filter(({ delivery }) => delivery?.via === 'wake');
  expect(wakes).toHaveLength(1);
  expect(JSON.stringify(wakes[0]?.delivery)).toContain('Child read the input.');
});

test('only a running child accepts human input', async () => {
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup);
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const input = (threadId: string, runId: string) =>
    harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId,
      threadId,
    });
  await expect(input(harness.threadId, rootRunId)).rejects.toThrow(
    'Human input reaches a running child'
  );
  const [childThreadId = ''] = await childThreads(harness);
  const [childRun] = startedRuns(await harness.core().read(childThreadId, 0));
  await rowsUntil(harness, childThreadId, finished(childRun?.runId ?? ''), 5000);
  await expect(input(childThreadId, childRun?.runId ?? '')).rejects.toThrow(
    'The child is not running'
  );
});

test('input a stopped child never read is committed as a failed run with its cause', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const [active] = startedRuns(await harness.core().read(childThreadId, 0));
  const runId = active?.runId ?? '';
  try {
    await harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId,
      threadId: childThreadId,
    });
    const stopped = harness
      .core()
      .stop({ commandId: randomUUID(), runId, threadId: childThreadId });
    release.resolve();
    await stopped;
  } finally {
    release.resolve();
  }
  const child = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== runId,
    5000
  );
  expect(finishedRuns(child).map(({ detail, outcome }) => ({ detail, outcome }))).toEqual([
    { detail: undefined, outcome: 'stopped' },
    { detail: 'The child run ended stopped before it read this input.', outcome: 'failed' },
  ]);
  // The input never reached the model.
  expect(model.doStreamCalls.filter((call) => userTexts(call).join('\n').includes(INPUT))).toEqual(
    []
  );
});
