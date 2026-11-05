/**
 * ADR-0028 step 3b: a person's message to a working thread is a notice. The
 * running run reads it at its next step and its own answer answers both; an
 * idle thread, or one whose run ended before it could read it, starts the
 * person's turn with it. It is never acknowledged and then dropped.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.ts';
import {
  blocked,
  childThreads,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  toolResults,
  userTexts,
  worker,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'CHILD_TASK: write the notes.';
const FOLLOW = 'FOLLOW_UP_INPUT: also add a title.';
const FOLLOWED = 'Notes written, with a title.';

type Child = 'answer' | 'block' | 'fail' | 'read';
type Harness = Awaited<ReturnType<typeof setupChildRunHost>>;

/**
 * The parent delegates TASK once. The child answers, fails, blocks until
 * stopped, or reads the notes first; any child step that sees FOLLOW answers it.
 */
function delegating(child: Child, foreground = false): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const texts = userTexts(call);
      // The child's thread opens with its task; a parent's wake only quotes it.
      if (texts[0]?.includes(TASK)) {
        if (texts.some((value) => value.includes(FOLLOW))) {
          return stream(text(FOLLOWED));
        }
        if (child === 'fail') {
          throw new Error('CHILD_MODEL_FAILED');
        }
        if (child === 'read' && toolResults(call).length === 0) {
          return stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
        }
        return child === 'block' ? blocked(call) : stream(text('Child done.'));
      }
      const answered = call.prompt.some((message) => message.role === 'tool');
      if (!toolNames(call).includes('agent-worker') || answered) {
        return stream(text('Parent continues.'));
      }
      const background = foreground
        ? { _background: { disposition: 'awaited', enabled: true } }
        : {};
      return stream(toolCall('agent-worker', { ...background, prompt: TASK }, 'delegate-1'));
    },
  });
}

async function childRun(harness: Harness, childThreadId: string): Promise<string> {
  const started = (await harness.core().read(childThreadId, 0)).find(
    (row) => row.event.type === 'run.started'
  )?.event;
  if (started?.type !== 'run.started') {
    throw new Error('No child run');
  }
  return started.runId;
}

const send = (harness: Harness, threadId: string, runId: string) =>
  harness.core().input({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: FOLLOW,
    runId,
    threadId,
  });

/** The child runs a parent's log was told about, in post order, with their outcomes. */
const reported = (rows: readonly HostLogRow[]): [string, string][] =>
  rows.flatMap(({ event }) =>
    event.type === 'notice.posted' && event.notice.kind === 'child'
      ? [[event.notice.entry.childRunId, event.notice.entry.outcome]]
      : []
  );

const finished = async (harness: Harness, threadId: string) =>
  (await harness.core().read(threadId, 0)).flatMap(({ event }) =>
    event.type === 'run.finished' ? [[event.runId, event.outcome]] : []
  );

/** A child that reads its notes once the person's input is committed, so the read's step ends after it. */
async function readingChild(foreground: boolean) {
  const sent = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const model = delegating('read', foreground);
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [worker],
    readFile: async () => {
      reading.resolve();
      await sent.promise;
      return { content: 'notes' };
    },
  });
  const started = harness.start('Delegate.');
  await reading.promise;
  const [child = ''] = await childThreads(harness);
  await expect(send(harness, child, await childRun(harness, child))).resolves.toEqual({
    accepted: true,
  });
  sent.resolve();
  await started;
  await harness.core().idle(harness.threadId);
  return { child, harness, model };
}

test('a working child reads the input at its next step, and its one run reports the answer', async () => {
  const { child, harness } = await readingChild(false);
  const runs = await finished(harness, child);
  expect(runs.map(([, outcome]) => outcome)).toEqual(['completed']);
  const told = reported(await harness.core().read(harness.threadId, 0));
  expect(told.map(([id]) => id)).toEqual(runs.map(([id]) => id));
  expect(told[0]?.[1]).toContain(FOLLOWED);
});

test("an awaited child's answer to the input is its parent's tool result", async () => {
  const { child, harness, model } = await readingChild(true);
  expect(await finished(harness, child)).toHaveLength(1);
  const parentSaw = model.doStreamCalls.find(
    (call) => !userTexts(call)[0]?.includes(TASK) && toolResults(call).length > 0
  );
  expect(JSON.stringify(parentSaw && toolResults(parentSaw))).toContain(FOLLOWED);
});

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
  const accepted = send(harness, childThreadId, await childRun(harness, childThreadId));
  release();
  await expect(accepted).resolves.toEqual({ accepted: true });
  await harness.core().idle(harness.threadId);
  return { childThreadId, harness };
}

test('an input committed after the child run ended starts its next run, and each run reports once', async () => {
  const model = delegating('answer');
  const { childThreadId, harness } = await heldChildEnd(model);
  const runs = await finished(harness, childThreadId);
  expect(runs.map(([, outcome]) => outcome)).toEqual(['completed', 'completed']);
  // In commit order: the child's answer ended before the input, so it reports, then the input's run does.
  const told = reported(await harness.core().read(harness.threadId, 0));
  expect(told.map(([id]) => id)).toEqual(runs.map(([id]) => id));
  expect(told[1]?.[1]).toContain(FOLLOWED);
  expect(
    model.doStreamCalls.filter((call) => userTexts(call).some((value) => value.includes(FOLLOW)))
  ).toHaveLength(1);
});

test('an input committed after a failed child run still starts its next run', async () => {
  const { childThreadId, harness } = await heldChildEnd(delegating('fail'));
  const runs = await finished(harness, childThreadId);
  expect(runs.map(([, outcome]) => outcome)).toEqual(['failed', 'completed']);
  expect(reported(await harness.core().read(harness.threadId, 0)).map(([id]) => id)).toEqual(
    runs.map(([id]) => id)
  );
});

/** The child's next run, started by the person, and whether its model read the earlier input. */
async function nextChildRun(harness: Harness, child: string, model: MockLanguageModelV4) {
  const before = model.doStreamCalls.length;
  const runs = await finished(harness, child);
  await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: runs.at(-1)?.[0] ?? null,
    prompt: 'Carry on.',
    threadId: child,
  });
  await harness.core().idle(harness.threadId);
  return model.doStreamCalls
    .slice(before)
    .some((call) => userTexts(call).some((value) => value.includes(FOLLOW)));
}

test('an input a stopped child never read waits for the next run, which reads it', async () => {
  const model = delegating('block');
  const harness = await setupChildRunHost(model, cleanup, { personas: [worker] });
  await harness.start('Delegate.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  const [child = ''] = await childThreads(harness);
  const runId = await childRun(harness, child);
  await send(harness, child, runId);
  await harness.core().stop({ commandId: randomUUID(), runId, threadId: child });
  await harness.core().idle(harness.threadId);
  // A stopped child starts nothing after it; the parent hears the stopped run.
  expect(await finished(harness, child)).toEqual([[runId, 'stopped']]);
  expect(reported(await harness.core().read(harness.threadId, 0)).map(([id]) => id)).toEqual([
    runId,
  ]);
  expect(await nextChildRun(harness, child, model)).toBe(true);
});

test('an input a restart finds untaken survives, and the next run reads it', async () => {
  const model = delegating('block');
  const harness = await setupChildRunHost(model, cleanup, { personas: [worker] });
  await harness.start('Delegate.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
  const [child = ''] = await childThreads(harness);
  const input = {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: FOLLOW,
    runId: await childRun(harness, child),
    threadId: child,
  };
  await harness.core().input(input);
  // The process dies while the child's step is still in flight.
  await harness.crash();
  // The client's unconfirmed retry is told the committed answer, and nothing woke the parent (Q-2).
  await expect(harness.core().input(input)).resolves.toEqual({ accepted: true });
  const parent = await harness.core().read(harness.threadId, 0);
  expect(
    parent.filter((row) => row.event.type === 'run.started' && row.event.delivery?.via === 'wake')
  ).toHaveLength(0);
  expect(await nextChildRun(harness, child, model)).toBe(true);
});

test('a working root reads the input at its next step, in the same run', async () => {
  const sent = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((value) => value.includes(FOLLOW))) {
        return stream(text(FOLLOWED));
      }
      return toolResults(call).length === 0
        ? stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'))
        : stream(text('Read it.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      reading.resolve();
      await sent.promise;
      return { content: 'notes' };
    },
  });
  const runId = await harness.start('Read the notes.');
  await reading.promise;
  await send(harness, harness.threadId, runId);
  sent.resolve();
  await harness.core().idle(harness.threadId);
  expect(await finished(harness, harness.threadId)).toEqual([[runId, 'completed']]);
  const taken = (await harness.core().read(harness.threadId, 0)).flatMap(({ event }) =>
    event.type === 'model.messages' && event.delivery?.inputs ? event.delivery.inputs : []
  );
  expect(taken).toHaveLength(1);
});
