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
  toolCalls,
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

test("a decision's live grant answers every sibling it now allows; the others stay pending", async () => {
  // The root policy asks for edits until the user grants them for the session.
  let granted = false;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (firstUser(call) === 'Fan out writes.') {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent saw every write.'));
        }
        return stream(
          answered(call as CallOptions)
            ? text('Parent continues.')
            : toolCalls([
                ['agent-worker', { prompt: 'WRITE_A' }, 'w-a'],
                ['agent-worker', { prompt: 'WRITE_B' }, 'w-b'],
                ['agent-worker', { prompt: 'RUN_C' }, 'w-c'],
              ])
        );
      }
      const task = firstUser(call);
      if (answered(call as CallOptions)) {
        return stream(text(`${task} done.`));
      }
      return stream(
        task === 'RUN_C'
          ? toolCall('run_command', { command: 'echo C' }, `${task}-call`)
          : toolCall('write_file', { path: `${task}.txt` }, `${task}-call`)
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [explorer, worker],
    policy: () => ({
      policies: {
        ...DEFAULT_PERMISSION_POLICIES,
        edit: granted ? 'allow' : 'ask',
        execute: 'ask',
        read: 'allow',
      },
      yolo: false,
    }),
  });
  await harness.start('Fan out writes.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(3);
  const pauses = await Promise.all(
    (await childThreads(harness)).map(async (threadId) => {
      const rows = await rowsUntil(harness, threadId, requested);
      const pause = rows.find(requested)?.event;
      if (pause?.type !== 'interaction.requested') {
        throw new Error('Child did not pause');
      }
      return { pause, threadId };
    })
  );
  const find = (toolCallId: string) => {
    const found = pauses.find(({ pause }) => pause.toolCallId === toolCallId);
    if (!found) {
      throw new Error(`No pause for ${toolCallId}`);
    }
    return found;
  };
  const writeA = find('WRITE_A-call');
  // "Allow edits this session" on A's card: the client grants, then approves A.
  granted = true;
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: writeA.pause.interactionId,
    runId: writeA.pause.runId,
    threadId: writeA.threadId,
  });
  await expect.poll(() => harness.writes.length).toBe(2);
  const bRows = await rowsUntil(
    harness,
    find('WRITE_B-call').threadId,
    (row) => row.event.type === 'interaction.responded'
  );
  // The host records that the live policy, not a person, answered B.
  expect(bRows.find((row) => row.event.type === 'interaction.responded')?.event).toMatchObject({
    by: 'policy',
    decision: 'approve',
  });
  // No execute grant was given: C still waits for a person.
  const cRows = await harness.core().read(find('RUN_C-call').threadId, 0);
  expect(cRows.some((row) => row.event.type === 'interaction.responded')).toBe(false);
});

test('children open the parent’s Memory on their own thread; a read-only child withholds working memory', async () => {
  const opened: { threadId: string; workingMemory: false | undefined }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (firstUser(call) === 'Both.') {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent read both.'));
        }
        return stream(
          answered(call as CallOptions)
            ? text('Parent continues.')
            : toolCalls([
                ['agent-explore', { prompt: 'EXPLORE_TASK' }, 'm-e'],
                ['agent-worker', { prompt: 'WORK_TASK' }, 'm-w'],
              ])
        );
      }
      return stream(text(`${firstUser(call)} done.`));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    openRun: async (context) => {
      opened.push({ threadId: context.threadId, workingMemory: context.workingMemory });
      return { close: async () => undefined };
    },
    personas: [explorer, worker],
  });
  const runId = await harness.start('Both.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const children = await childThreads(harness);
  await expect.poll(() => opened.length).toBeGreaterThanOrEqual(3);
  const byThread = new Map(opened.map((entry) => [entry.threadId, entry.workingMemory]));
  expect(byThread.get(harness.threadId)).toBeUndefined();
  const personaOf = async (threadId: string) => {
    const origin = (await harness.core().read(threadId, 0))[0]?.event;
    return origin?.type === 'thread.started' && 'origin' in origin ? origin.origin.persona : '';
  };
  for (const threadId of children) {
    expect(byThread.has(threadId)).toBe(true);
    expect(byThread.get(threadId)).toBe(
      (await personaOf(threadId)) === 'explore' ? false : undefined
    );
  }
});
