/**
 * BST-1932: a child borrows its parent run's admission, so the platform
 * selection behind it (on desktop, Main's admitted tools and roots) stays open
 * until the parent run and every child borrowing it have settled, and is then
 * released exactly once. The recorded defect: AT-06's background worker
 * approved its write after the root run had finished, and the write failed
 * with "Platform thread has no admitted capabilities".
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { withHostDelegationTools } from '../src/child-runs.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
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

/** One platform selection per admission, as Main keeps one per admitted run. */
interface Selection {
  closes: number;
  readonly prompt: string | undefined;
}

/**
 * The default admission, except that each admission's write tool is bound to
 * its own selection and refuses once that selection is released, as desktop's
 * Main-bound tools do.
 */
function selectionAdmission(selections: Selection[], writes: string[]) {
  return (platform: HostPlatform): HostPlatform['admitRun'] =>
    async (request) => {
      const selection: Selection = { closes: 0, prompt: request.prompt };
      selections.push(selection);
      const write: HostTool = {
        description: 'Write a workspace file',
        execute: async (input) => {
          if (selection.closes > 0) {
            throw new Error('Platform thread has no admitted capabilities');
          }
          writes.push(JSON.stringify(input));
          return { written: true };
        },
        identity: 'native-write-generation-1',
        inputSchema: z.object({ path: z.string() }),
        risk: 'edit',
      };
      const tools = withHostDelegationTools(
        { ...platform.tools, write_file: write },
        platform.delegation
      );
      return {
        close: async () => {
          selection.closes += 1;
        },
        configuration: {},
        delegation: platform.delegation,
        model: await (platform.resolveModel?.(request.modelId) ??
          Promise.reject(new Error('No model'))),
        snapshot: {
          configuration: {},
          maxSteps: platform.maxSteps ?? 4,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      };
    };
}

const LEDGER = 'Background invocations of this turn';
const firstUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call)[0] ?? '';
const lastUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call).at(-1) ?? '';
const answered = (call: CallOptions): boolean => toolResults(call).length > 0;
const requested = (row: HostLogRow) => row.event.type === 'interaction.requested';

/**
 * The root hands WRITE_TASK to a background Worker. `nested` makes that Worker
 * hand it on to a foreground Worker, which writes; otherwise it writes itself.
 */
function treeModel(nested: boolean) {
  return new MockLanguageModelV4({
    doStream: async (raw) => {
      const call = raw as CallOptions;
      const task = firstUser(call);
      if (task === 'Write.') {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Root read the result.'));
        }
        return stream(
          answered(call)
            ? text('Root continues while Worker runs.')
            : toolCall('agent-worker', { prompt: 'WRITE_TASK' }, 'root-1')
        );
      }
      if (task !== 'WRITE_TASK' && task !== 'LEAF_TASK') {
        return stream(text(`${task} answered.`));
      }
      if (answered(call)) {
        return stream(text(`${task} done.`));
      }
      return stream(
        nested && task === 'WRITE_TASK'
          ? toolCall('agent-worker', { prompt: 'LEAF_TASK' }, 'worker-1')
          : toolCall('write_file', { path: `${task}.txt` }, `${task}-write`)
      );
    },
  });
}

async function setup(nested: boolean) {
  const selections: Selection[] = [];
  const writes: string[] = [];
  const harness = await setupChildRunHost(
    treeModel(nested),
    cleanup,
    {
      personas: [worker],
      policy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
        yolo: false,
      }),
    },
    selectionAdmission(selections, writes)
  );
  return { harness, selections, writes };
}

/** The write approval one of the tree's `count` child threads pauses on. */
async function pausedWrite(harness: ChildRunHarness, count: number) {
  let found: { pause: HostLogRow['event']; threadId: string } | undefined;
  await expect
    .poll(async () => {
      const threads = await childThreads(harness);
      for (const threadId of threads.length === count ? threads : []) {
        const pause = (await harness.core().read(threadId, 0)).find(requested)?.event;
        found = pause ? { pause, threadId } : found;
      }
      return found?.pause.type;
    })
    .toBe('interaction.requested');
  const pause = found?.pause;
  if (pause?.type !== 'interaction.requested') {
    throw new Error('The child did not pause on its write');
  }
  return { pause, threadId: found?.threadId ?? '' };
}

test("a background child's approved write runs after its root run finished; the root's selection is released once, after the child settles", async () => {
  const { harness, selections, writes } = await setup(false);
  const runId = await harness.start('Write.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const { pause, threadId } = await pausedWrite(harness, 1);
  // The finished root run no longer needs its selection, but its child does.
  expect(selections.map(({ closes }) => closes)).toEqual([0]);

  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pause.interactionId,
    runId: pause.runId,
    threadId,
  });
  const childRows = await rowsUntil(harness, threadId, finished(pause.runId));
  expect(childRows.find(finished(pause.runId))?.event).toMatchObject({ outcome: 'completed' });
  expect(writes).toEqual([JSON.stringify({ path: 'WRITE_TASK.txt' })]);
  // The child's report wakes the root on a selection of its own; each closes once.
  await expect.poll(() => selections.map(({ closes }) => closes)).toEqual([1, 1]);
});

test("the root's next message runs on its own selection while a child still holds the first", async () => {
  const { harness, selections, writes } = await setup(false);
  const runId = await harness.start('Write.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const { pause, threadId } = await pausedWrite(harness, 1);

  const next = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: null,
    prompt: 'Anything else?',
    threadId: harness.threadId,
  });
  await rowsUntil(harness, harness.threadId, finished(next.runId));
  // The next turn's selection is released at its end; the child still holds the first.
  expect(selections.map(({ closes, prompt }) => ({ closes, prompt }))).toEqual([
    { closes: 0, prompt: 'Write.' },
    { closes: 1, prompt: 'Anything else?' },
  ]);

  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pause.interactionId,
    runId: pause.runId,
    threadId,
  });
  await rowsUntil(harness, threadId, finished(pause.runId));
  expect(writes).toEqual([JSON.stringify({ path: 'WRITE_TASK.txt' })]);
  await expect.poll(() => selections[0]?.closes).toBe(1);
});

test("a grandchild's approved write runs on the root's selection, which is released once after the whole tree settles", async () => {
  const { harness, selections, writes } = await setup(true);
  const runId = await harness.start('Write.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const { pause, threadId } = await pausedWrite(harness, 2);
  expect(selections.map(({ closes }) => closes)).toEqual([0]);

  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pause.interactionId,
    runId: pause.runId,
    threadId,
  });
  await rowsUntil(harness, threadId, finished(pause.runId));
  expect(writes).toEqual([JSON.stringify({ path: 'LEAF_TASK.txt' })]);
  for (const child of await childThreads(harness)) {
    await rowsUntil(harness, child, (row) => row.event.type === 'run.finished');
  }
  await expect.poll(() => selections.map(({ closes }) => closes)).toEqual([1, 1]);
});
