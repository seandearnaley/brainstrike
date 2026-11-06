/**
 * BST-1932: children and their delivery under the production Memory owner. A
 * delegated child's first run and a parent's wake are admitted by the host,
 * not by a client command, and the committed identities every reader derives
 * (Memory, the renderer's projection) name them as the host admitted them.
 * Memory rebuilds earlier turns from the committed log, so a delivered outcome
 * and a next-turn ledger must survive that rebuild as they do without Memory.
 */
import { randomUUID } from 'node:crypto';
import type { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { hostChildCallSign } from '../src/child-presentation.js';
import { committedRunIdentity } from '../src/committed-identities.js';
import type { HostPlatform } from '../src/ports.js';
import { hostRunMemoryOptions } from '../src/production-platform.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolCalls,
  toolNames,
  toolResults,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'MEMORY_TASK: read the notes.';
const LEDGER = 'Background invocations of this turn';
/** Real Memory over a real store under the fleet's load. */
const SETTLED = 15_000;

const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

/** The production run owner, as the host platform opens it for every run. */
function productionMemory(store: StateStore, lastMessages = 10): HostPlatform['openRun'] {
  const resourceId = randomUUID();
  const memory = {
    native: {
      options: {
        lastMessages,
        observationalMemory: false as const,
        workingMemory: { enabled: true, scope: 'thread' as const },
      },
    },
    recordPrompt: async () => undefined,
    resourceId,
  };
  // Composed exactly as the production platform opens each run's Memory.
  return (context) =>
    StateStoreHostMemory.open(context, {
      ...hostRunMemoryOptions(memory, context),
      providerRequestContext: () => ({ inputTokenLimit: 30_000, provider: 'openai' }),
      store,
    });
}

type Streamed = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;

/**
 * The parent delegates once; `child` answers the child's provider call once the
 * parent's last step has begun, so a wake, not that step, takes its report.
 */
function delegatingModel(child: (call: CallOptions) => Streamed | Promise<Streamed>) {
  const lastStep = Promise.withResolvers<void>();
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (!toolNames(call).includes('agent-explore')) {
        await lastStep.promise;
        return child(call);
      }
      if (user.endsWith('Delegate.') && !call.prompt.some((message) => message.role === 'tool')) {
        return stream(toolCall('agent-explore', { prompt: TASK }, 'memory-1'));
      }
      lastStep.resolve();
      return stream(text(user.includes(LEDGER) ? 'Parent read the child.' : 'Parent continues.'));
    },
  });
}

test('a background child and its wake run under the root Memory with host-admitted identities', async () => {
  const model = delegatingModel(() => stream(text('Child outcome.')));
  const harness = await setupChildRunHost(model, cleanup, { memory: productionMemory });
  const rootRunId = await harness.start('Delegate.');
  const parentRows = await rowsUntil(
    harness,
    harness.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== rootRunId,
    SETTLED
  );
  const [childThreadId] = await childThreads(harness);
  const childRows = await harness.core().read(childThreadId ?? '', 0);
  const [childRun] = startedRuns(childRows);
  const wake = startedRuns(parentRows).find((run) => run.runId !== rootRunId);

  expect(childRows.find(finished(childRun?.runId ?? ''))?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(parentRows.find(finished(wake?.runId ?? ''))?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(wake?.delivery).toMatchObject({ via: 'wake' });
  // The wake's own message delivers the outcome, naming the child as the user sees it.
  const wakeCall = model.doStreamCalls.find((call) =>
    userTexts(call).some((input) => input.includes(LEDGER))
  ) as CallOptions;
  const wakeInput = userTexts(wakeCall).join('\n');
  expect(wakeInput).toContain('Child outcome.');
  expect(wakeInput).toContain(hostChildCallSign(childThreadId ?? ''));
  expect(JSON.stringify(toolResults(wakeCall))).not.toContain('Child outcome.');
  // The child's task is its thread's first user message, keyed by the child thread.
  expect(committedRunIdentity(childRows, childRun?.runId ?? '')).toMatchObject({
    assistantMessageId: childRun?.runId,
    parentMessageId: null,
    userMessageId: childThreadId,
  });
  // A wake answers its delivery after the run it was admitted behind.
  expect(committedRunIdentity(parentRows, wake?.runId ?? '')).toMatchObject({
    assistantMessageId: wake?.runId,
    parentMessageId: rootRunId,
    userMessageId: wake?.delivery?.via === 'wake' ? wake.delivery.messageId : 'missing',
  });
});

test('a wake reads its outcome after Memory has left the dispatching turn behind', async () => {
  // The field failure: a long parent turn's tool results leave Memory's
  // window, and the outcome kept only there never reached the wake.
  const model = delegatingModel(() => stream(text('Child outcome.')));
  const harness = await setupChildRunHost(model, cleanup, {
    memory: (store) => productionMemory(store, 1),
  });
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(
    harness,
    harness.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== rootRunId,
    SETTLED
  );
  const wakeCall = model.doStreamCalls.find((call) =>
    userTexts(call).some((input) => input.includes(LEDGER))
  ) as CallOptions;
  expect(JSON.stringify(toolResults(wakeCall))).not.toContain('Background task started.');
  expect(userTexts(wakeCall).join('\n')).toContain('Child outcome.');
});

test('a later wake of the same turn still reads the conclusion an earlier wake delivered', async () => {
  // Two children of one turn settle in two wakes; Memory's window keeps only
  // the latest message, so the first wake's message is gone by the second.
  // The later ledger lists the earlier outcome by its opening, not in full.
  const conclusion = 'Fast outcome: the notes name three owners.';
  const report = [conclusion, ...Array.from({ length: 80 }, () => 'Supporting detail.')].join(' ');
  let releaseSlow = (): void => undefined;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  // The fast child reports once the parent's last step has begun, so a wake takes it.
  const lastStep = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (!toolNames(call).includes('agent-explore')) {
        if (user.includes('SLOW_TASK')) {
          await slow;
          return stream(text('Slow outcome.'));
        }
        await lastStep.promise;
        return stream(text(report));
      }
      if (user.endsWith('Delegate.') && !call.prompt.some((message) => message.role === 'tool')) {
        return stream(
          toolCalls([
            ['agent-explore', { prompt: 'FAST_TASK: read the notes.' }, 'memory-fast'],
            ['agent-explore', { prompt: 'SLOW_TASK: read the notes.' }, 'memory-slow'],
          ])
        );
      }
      lastStep.resolve();
      return stream(text('Parent continues.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    memory: (store) => productionMemory(store, 1),
  });
  await harness.start('Delegate.');
  /** How many wakes (runs that deliver child outcomes) have finished on the parent. */
  const finishedWakes = async (): Promise<number> => {
    const rows = await harness.core().read(harness.threadId, 0);
    const wakes = new Set(startedRuns(rows).flatMap((run) => (run.delivery ? [run.runId] : [])));
    return rows.filter(({ event }) => event.type === 'run.finished' && wakes.has(event.runId))
      .length;
  };
  await expect.poll(finishedWakes, { timeout: SETTLED }).toBe(1);
  releaseSlow();
  await expect.poll(finishedWakes, { timeout: SETTLED }).toBe(2);
  const ledgerCalls = model.doStreamCalls.filter((call) =>
    userTexts(call).some((input) => input.includes(LEDGER))
  );
  const lastWake = userTexts(ledgerCalls.at(-1) as CallOptions).join('\n');
  expect(lastWake).toContain('Slow outcome.');
  // The whole report left with the first wake's message; its conclusion did not.
  expect(lastWake).not.toContain(report);
  expect(lastWake).toContain(conclusion);
});

test('a next turn under Memory reads the interrupted child ledger once, and later turns recall it', async () => {
  const model = delegatingModel((call) => blocked(call));
  const harness = await setupChildRunHost(model, cleanup, { memory: productionMemory });
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), SETTLED);
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  await harness.crash();

  const next = await harness.start('What happened?');
  await rowsUntil(harness, harness.threadId, finished(next), SETTLED);
  const nextInputs = userTexts(model.doStreamCalls.at(-1) as CallOptions).join('\n');
  expect(nextInputs).toContain(`${LEDGER} — 1 total: 0 returned, 1 failed`);
  expect(nextInputs).toContain('What happened?');

  const after = await harness.start('Anything else?');
  await rowsUntil(harness, harness.threadId, finished(after), SETTLED);
  const afterInputs = userTexts(model.doStreamCalls.at(-1) as CallOptions).join('\n');
  expect(afterInputs.split(LEDGER)).toHaveLength(2);
});

test("under Memory, a running parent's next step reads a worker's report beside its own task", async () => {
  const OUTCOME = 'MEMORY-STEP-OUTCOME-17';
  let harness: Awaited<ReturnType<typeof setupChildRunHost>> | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return stream(text(OUTCOME));
      }
      const answered = toolResults(call).length;
      if (answered === 0) {
        return stream(toolCall('agent-explore', { prompt: 'Look.' }, 'call-look'));
      }
      if (answered === 1) {
        return stream(toolCall('read_file', { path: 'notes.md' }, 'call-read'));
      }
      return stream(text('Done.'));
    },
  });
  harness = await setupChildRunHost(model, cleanup, {
    memory: productionMemory,
    readFile: async () => {
      if (!harness) {
        throw new Error('The host is not set up');
      }
      await rowsUntil(
        harness,
        harness.threadId,
        ({ event }) => event.type === 'notice.posted',
        SETTLED
      );
      return { content: 'notes' };
    },
  });
  await harness.start(TASK);
  await harness.core().idle(harness.threadId);
  const last = model.doStreamCalls
    .filter((call) => toolNames(call).includes('agent-explore'))
    .at(-1);
  if (!last) {
    throw new Error('The parent made no call');
  }
  // The step's request keeps the run's own task, its tool calls and the report.
  expect(userTexts(last).join('\n')).toContain(TASK);
  expect(userTexts(last).join('\n')).toContain(OUTCOME);
  expect(toolResults(last)).toHaveLength(2);
  // A later turn rebuilds that turn from the log, the report inside it.
  await harness.start('What did it find?');
  await harness.core().idle(harness.threadId);
  expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(OUTCOME);
});
