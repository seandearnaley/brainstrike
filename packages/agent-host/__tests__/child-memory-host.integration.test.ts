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
function productionMemory(store: StateStore): HostPlatform['openRun'] {
  const resourceId = randomUUID();
  const memory = {
    native: {
      options: {
        lastMessages: 10,
        observationalMemory: false as const,
        semanticRecall: false,
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

/** The parent delegates once; `child` answers the child's provider call. */
function delegatingModel(child: (call: CallOptions) => Streamed) {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (!toolNames(call).includes('agent-explore')) {
        return child(call);
      }
      if (user.endsWith('Delegate.') && !call.prompt.some((message) => message.role === 'tool')) {
        return stream(toolCall('agent-explore', { prompt: TASK }, 'memory-1'));
      }
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
  // The wake reads the saved outcome in place of the acknowledgement Memory recalled.
  const wakeCall = model.doStreamCalls.find((call) =>
    userTexts(call).some((input) => input.includes(LEDGER))
  ) as CallOptions;
  expect(JSON.stringify(toolResults(wakeCall))).toContain('Child outcome.');
  expect(JSON.stringify(toolResults(wakeCall))).not.toContain('Background task started.');
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
