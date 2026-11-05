/**
 * A Stop commits its intent in the host's one admission queue and joins the
 * stopped work outside it. A tree whose tools are slow to die holds only its
 * own Stop's reply, never another thread's command (audit SC-6).
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { setupChildRunHost, stream, text, toolCall } from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** A host whose run is in a read that ignores Stop until `release`. */
async function slowStopHost() {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) =>
      stream(
        call.prompt.some((message) => message.role === 'tool')
          ? text('Read it.')
          : toolCall('read_file', { path: 'notes.md' }, 'read-1')
      ),
  });
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      reading.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  const runId = await harness.start('Read the notes.');
  await reading.promise;
  return { harness, release: release.resolve, runId };
}

test("a Stop whose cleanup is slow holds no other thread's command", async () => {
  const { harness, release, runId } = await slowStopHost();
  let replied = false;
  const stop = harness
    .core()
    .stop({ commandId: randomUUID(), runId, threadId: harness.threadId })
    .finally(() => {
      replied = true;
    });

  // Another thread starts and runs while the stopped read is still in flight.
  const other = await harness.core().startThread({ commandId: randomUUID() });
  await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Hello.',
    threadId: other.threadId,
  });
  expect(replied).toBe(false);

  release();
  // Stop still replies only once the stopped work has ended.
  expect(await stop).toEqual({ outcome: 'stopped' });
  const rows = await harness.core().read(harness.threadId, 0);
  expect(
    rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
  ).toEqual(['stopped']);
});

test("the thread's next message waits for its Stop to finish, then runs", async () => {
  const { harness, release, runId } = await slowStopHost();
  const stop = harness.core().stop({ commandId: randomUUID(), runId, threadId: harness.threadId });

  const next = harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Something else.',
    threadId: harness.threadId,
  });
  release();

  await stop;
  const { runId: nextRun } = await next;
  await harness.core().idle(harness.threadId);
  const rows = await harness.core().read(harness.threadId, 0);
  expect(
    rows.flatMap(({ event }) =>
      event.type === 'run.finished' ? [[event.runId, event.outcome]] : []
    )
  ).toEqual([
    [runId, 'stopped'],
    [nextRun, 'completed'],
  ]);
});
