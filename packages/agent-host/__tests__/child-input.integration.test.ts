/**
 * BST-1932: a person's input into a running child. The committed run/input is
 * the input's one record: an input whose commit lands after the child's run
 * ended starts the child's next run itself, and one a restart finds untaken is
 * committed as a refused run. It is never acknowledged and then dropped.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  blocked,
  childThreads,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'CHILD_TASK: write the notes.';
const FOLLOW = 'FOLLOW_UP_INPUT: also add a title.';

/** The parent delegates TASK once; the child answers TASK, fails, or blocks until stopped. */
function delegating(child: 'answer' | 'block' | 'fail'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const texts = userTexts(call);
      if (texts.some((value) => value.includes(FOLLOW))) {
        return stream(text('Follow-up done.'));
      }
      if (texts.some((value) => value.includes(TASK))) {
        if (child === 'fail') {
          throw new Error('CHILD_MODEL_FAILED');
        }
        return child === 'answer' ? stream(text('Child done.')) : blocked(call);
      }
      const answered = call.prompt.some((message) => message.role === 'tool');
      if (!toolNames(call).includes('agent-worker') || answered) {
        return stream(text('Parent continues.'));
      }
      return stream(toolCall('agent-worker', { prompt: TASK }, 'delegate-1'));
    },
  });
}

async function childRun(
  core: { read: (threadId: string, fromSeq: number) => Promise<{ event: { type: string } }[]> },
  childThreadId: string
): Promise<string> {
  const started = (await core.read(childThreadId, 0)).find(
    (row) => row.event.type === 'run.started'
  )?.event;
  if (started?.type !== 'run.started' || !('runId' in started)) {
    throw new Error('No child run');
  }
  return started.runId as string;
}

/** The child's run.finished held until `release`, so an input commits after it. */
async function heldChildEnd(model: MockLanguageModelV4) {
  let rootThread = '';
  let gate: Promise<void> | undefined;
  let release: () => void = () => undefined;
  const held = Promise.withResolvers<string>();
  const harness = await setupChildRunHost(model, cleanup, {
    // Hold the child's run.finished; the store commits in order, so the input lands after it.
    holdAppend: async (items) => {
      const child = items.find((item) => item.threadId !== rootThread && rootThread !== '');
      if (!child) {
        return;
      }
      if (!gate && items.some((item) => item.event.type === 'run.finished')) {
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        held.resolve(child.threadId);
        await gate;
        return;
      }
      if (gate !== undefined) {
        await gate;
      }
    },
    personas: [worker],
  });
  rootThread = harness.threadId;
  await harness.start('Delegate.');
  const childThreadId = await held.promise;
  const accepted = harness.core().input({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: FOLLOW,
    runId: await childRun(harness.core(), childThreadId),
    threadId: childThreadId,
  });
  release();
  await expect(accepted).resolves.toEqual({ accepted: true });
  return { childThreadId, harness };
}

/** The parent's runs that deliver the child's result. */
async function parentDeliveries(
  harness: Awaited<ReturnType<typeof setupChildRunHost>>,
  childThreadId: string
): Promise<string[]> {
  return (await harness.core().read(harness.threadId, 0)).flatMap(({ event }) =>
    event.type === 'run.started' &&
    (event.delivery?.entries ?? []).some((entry) => entry.childThreadId === childThreadId)
      ? [event.runId]
      : []
  );
}

test('an input committed after a failed child run is refused, and the parent still hears the child', async () => {
  const { childThreadId, harness } = await heldChildEnd(delegating('fail'));
  await harness.core().idle(harness.threadId);
  expect(await parentDeliveries(harness, childThreadId)).toHaveLength(1);
  const refused = (await harness.core().read(childThreadId, 0)).flatMap(({ event }) =>
    event.type === 'run.finished' ? [event] : []
  );
  expect(refused.at(-1)).toMatchObject({ outcome: 'failed' });
  expect(refused.at(-1)?.detail).toContain('before it read this input');
});

test('an input committed after the child run ended starts its next run, and each run reports once', async () => {
  const model = delegating('answer');
  const { childThreadId, harness } = await heldChildEnd(model);
  expect(await childThreads(harness)).toEqual([childThreadId]);
  const finishedRuns = async (threadId: string) =>
    (await harness.core().read(threadId, 0)).flatMap(({ event }) =>
      event.type === 'run.finished' ? [event.runId] : []
    );
  await harness.core().idle(harness.threadId);
  const [answered, followed] = await finishedRuns(childThreadId);
  // In commit order: the child's answer ended before the input, so it reports, then the input's run does.
  const reported = (await harness.core().read(harness.threadId, 0)).flatMap(({ event }) =>
    event.type === 'run.started'
      ? (event.delivery?.entries ?? []).flatMap((entry) =>
          entry.childThreadId === childThreadId ? [entry.childRunId] : []
        )
      : []
  );
  expect(reported).toEqual([answered, followed]);
  expect(
    model.doStreamCalls.filter((call) => userTexts(call).some((value) => value.includes(FOLLOW)))
  ).toHaveLength(1);
});

test('an input a restart finds untaken is committed as a refused run, waking no one', async () => {
  const model = delegating('block');
  const harness = await setupChildRunHost(model, cleanup, { personas: [worker] });
  await harness.start('Delegate.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  const [child = ''] = await childThreads(harness);
  const input = {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: FOLLOW,
    runId: await childRun(harness.core(), child),
    threadId: child,
  };
  await harness.core().input(input);
  // The process dies while the child's step is still in flight.
  await harness.crash();
  const rows = await harness.core().read(child, 0);
  const inputRun = rows.find(
    (row) => row.event.type === 'run.started' && row.event.prompt?.includes(FOLLOW)
  )?.event;
  expect(inputRun?.type === 'run.started' && inputRun.runId).toBeTruthy();
  const runId = inputRun?.type === 'run.started' ? inputRun.runId : '';
  expect(
    rows.find((row) => row.event.type === 'run.finished' && row.event.runId === runId)?.event
  ).toMatchObject({
    detail: 'The host restarted before the child read this input.',
    outcome: 'failed',
  });
  // The client's unconfirmed retry is told the committed answer, and nothing woke the parent (Q-2).
  await expect(harness.core().input(input)).resolves.toEqual({ accepted: true });
  const parent = await harness.core().read(harness.threadId, 0);
  expect(
    parent.filter((row) => row.event.type === 'run.started' && row.event.delivery?.via === 'wake')
  ).toHaveLength(0);
});
