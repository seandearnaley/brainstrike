/**
 * Audit D-7: a parent told a background worker is still running must hear how
 * it ended, even when the worker's thread is deleted before it reports. The
 * worker's notice commits on the parent's log, which outlives the erase.
 */
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
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test("deleting a running worker's thread still tells its parent the worker was cancelled", async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return blocked(call);
      }
      const dispatched = call.prompt.some((message) => message.role === 'tool');
      if (userTexts(call).join('\n').endsWith('Delegate.') && !dispatched) {
        return stream(toolCall('agent-explore', { prompt: 'Read the notes.' }, 'explore-1'));
      }
      return stream(text('Parent continues.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  await harness.start('Delegate.');
  await expect.poll(() => childThreads(harness)).toHaveLength(1);
  const [child] = await childThreads(harness);

  await harness.core().deleteThread({ threadId: child ?? '' });
  await harness.core().idle(harness.threadId);

  expect(await childThreads(harness)).toEqual([]);
  const notices = (await harness.core().read(harness.threadId, 0)).flatMap(({ event }) =>
    event.type === 'notice.posted' ? [event.notice] : []
  );
  expect(notices).toEqual([
    expect.objectContaining({
      entry: expect.objectContaining({ childThreadId: child, state: 'cancelled' }),
    }),
  ]);
});
