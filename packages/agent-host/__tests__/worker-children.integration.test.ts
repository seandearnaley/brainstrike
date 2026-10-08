/**
 * BST-1932 S3: the general worker. Its authority is the parent's admitted
 * tools under the root's live policy; its approvals, questions and plans are
 * ordinary host interactions on the child thread, answered through the same
 * gate; recursion is bounded by maxDepth (AT-21).
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  explorer,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  toolResults,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
const lastUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call).at(-1) ?? '';
const firstUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call)[0] ?? '';
const answered = (call: CallOptions): boolean => toolResults(call).length > 0;
const runsOf = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const requested = (row: HostLogRow) => row.event.type === 'interaction.requested';

/** The worker child of the first delegation, and its pending interaction once it pauses. */
async function pausedChild(harness: ChildRunHarness) {
  let threadId = '';
  await expect
    .poll(async () => {
      threadId = (await childThreads(harness))[0] ?? '';
      return threadId;
    })
    .not.toBe('');
  const rows = await rowsUntil(harness, threadId, requested);
  const pause = rows.find(requested)?.event;
  if (pause?.type !== 'interaction.requested') {
    throw new Error('The child did not pause on an interaction');
  }
  return { pause, threadId };
}

/** The parent hands WRITE_TASK to Worker in the background and keeps going. */
function parentStep(call: CallOptions) {
  if (lastUser(call).includes(LEDGER)) {
    return stream(text('Parent saw the result.'));
  }
  return stream(
    answered(call)
      ? text('Parent continues while Worker runs.')
      : toolCall(
          'agent-worker',
          { prompt: firstUser(call) === 'Ask.' ? 'ASK_TASK' : 'WRITE_TASK' },
          'w-1'
        )
  );
}

test("a worker's write asks under the root's live policy; answering in the child thread resumes that child alone", async () => {
  const policyThreads: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (['Write.', 'Ask.'].includes(firstUser(call))) {
        return parentStep(call as CallOptions);
      }
      return stream(
        answered(call as CallOptions)
          ? text('Wrote out.txt.')
          : toolCall('write_file', { path: 'out.txt' }, 'write-1')
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [explorer, worker],
    policy: (threadId) => {
      policyThreads.push(threadId ?? '');
      return {
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
        yolo: false,
      };
    },
  });
  const runId = await harness.start('Write.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const { pause, threadId } = await pausedChild(harness);
  expect(pause).toMatchObject({ kind: 'approval', toolId: 'write_file' });
  expect(harness.writes).toEqual([]);
  // A child's pause never wakes the parent (ADR-0010).
  expect(runsOf(await harness.core().read(harness.threadId, 0))).toHaveLength(1);
  // Every decision in the tree reads the root thread's live policy.
  expect(new Set(policyThreads)).toEqual(new Set([harness.threadId]));

  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pause.interactionId,
    runId: pause.runId,
    threadId,
  });
  await rowsUntil(harness, threadId, finished(pause.runId));
  expect(harness.writes).toEqual([JSON.stringify({ path: 'out.txt' })]);
  const rows = await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some((started) => started.delivery?.via === 'wake')
  );
  expect(runsOf(rows).find((started) => started.delivery?.via === 'wake')?.prompt).toContain(
    `${LEDGER} — 1 total: 1 returned`
  );
});

test('a worker child asks the user a question and continues with the answer', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (['Write.', 'Ask.'].includes(firstUser(call))) {
        return parentStep(call as CallOptions);
      }
      return stream(
        answered(call as CallOptions)
          ? text(`Using ${JSON.stringify(toolResults(call as CallOptions))}.`)
          : toolCall('ask_user', { question: 'Which root?' }, 'ask-1')
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, { personas: [explorer, worker] });
  await harness.start('Ask.');
  const { pause, threadId } = await pausedChild(harness);
  expect(pause).toMatchObject({ kind: 'question', toolId: 'ask_user' });
  await harness.core().resume({
    commandId: randomUUID(),
    interactionId: pause.interactionId,
    resumeData: { answer: 'Local' },
    runId: pause.runId,
    threadId,
  });
  const rows = await rowsUntil(harness, threadId, finished(pause.runId));
  expect(rows.find(finished(pause.runId))?.event).toMatchObject({ outcome: 'completed' });
  expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt ?? [])).toContain('Local');
});

test.each([
  { levelOneDelegates: true, maxDepth: 2 },
  { levelOneDelegates: false, maxDepth: 1 },
])(
  'workers delegate onward only above maxDepth $maxDepth; read-only children never do',
  async ({ levelOneDelegates, maxDepth }) => {
    const surfaces = new Map<string, string[]>();
    const model = new MockLanguageModelV4({
      doStream: async (call) => {
        const task = firstUser(call);
        const names = toolNames(call);
        if (task === 'Recurse.') {
          if (lastUser(call).includes(LEDGER)) {
            return stream(text('Parent done.'));
          }
          return stream(
            answered(call as CallOptions)
              ? text('Parent continues.')
              : toolCall('agent-worker', { prompt: 'LEVEL_1' }, 'r-1')
          );
        }
        surfaces.set(task, names);
        if (
          task === 'LEVEL_1' &&
          names.includes('agent-worker') &&
          !answered(call as CallOptions)
        ) {
          return stream(toolCall('agent-worker', { prompt: 'LEVEL_2' }, 'r-2'));
        }
        return stream(text(`${task} done.`));
      },
    });
    const harness = await setupChildRunHost(model, cleanup, {
      personas: [explorer, worker],
      settings: { maxDepth },
    });
    const runId = await harness.start('Recurse.');
    await rowsUntil(harness, harness.threadId, finished(runId));
    await expect.poll(() => surfaces.has('LEVEL_1')).toBe(true);
    const delegation = (names: string[] | undefined) =>
      (names ?? []).filter((name) => name.startsWith('agent-')).sort();
    expect(delegation(surfaces.get('LEVEL_1'))).toEqual(
      levelOneDelegates ? ['agent-explore', 'agent-worker'] : []
    );
    if (levelOneDelegates) {
      await expect.poll(() => surfaces.has('LEVEL_2')).toBe(true);
      expect(delegation(surfaces.get('LEVEL_2'))).toEqual([]);
      // A child's own delegation runs in the foreground and returns its result.
      await expect.poll(async () => (await childThreads(harness)).length).toBe(2);
    }
  }
);

test('the child deadline also bounds the leg that resumes after an approval', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (['Write.', 'Ask.'].includes(firstUser(call))) {
        return parentStep(call as CallOptions);
      }
      return answered(call as CallOptions)
        ? blocked(call)
        : stream(toolCall('write_file', { path: 'out.txt' }, 'write-1'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [explorer, worker],
    policy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
      yolo: false,
    }),
    settings: { maxChildRuntimeMs: 1000 },
  });
  await harness.start('Write.');
  const { pause, threadId } = await pausedChild(harness);
  // The paused leg's deadline ended with it; the answer starts a fresh one.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pause.interactionId,
    runId: pause.runId,
    threadId,
  });
  const rows = await rowsUntil(harness, threadId, finished(pause.runId), 5000);
  expect(rows.find(finished(pause.runId))?.event).toMatchObject({
    detail: 'Task timed out after 1000ms',
    outcome: 'failed',
  });
  expect(harness.writes).toHaveLength(1);
});
