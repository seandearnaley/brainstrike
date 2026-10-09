/**
 * BST-1932 (F15): a delegation commits the admitted persona's label and mode
 * with the child's origin, so the child's toolbar names the profile the child
 * was admitted under, never the current persona list.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  childThreads,
  explorer,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('a child origin records the label and mode of the persona it was admitted under', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return stream(text('Child done.'));
      }
      return call.prompt.some((message) => message.role === 'tool')
        ? stream(text('Parent done.'))
        : stream(toolCall('agent-explore', { prompt: 'Look.' }, 'profile-1'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [{ ...explorer, label: 'Explorer', mode: 'read-only' }],
  });
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const [started] = await harness.core().read(childThreadId, 0);
  expect(started?.event).toMatchObject({
    origin: { persona: 'explore', profile: { label: 'Explorer', mode: 'read-only' } },
    type: 'thread.started',
  });
  expect(harness.core().listChildren(harness.threadId)).toMatchObject([
    { origin: { profile: { label: 'Explorer', mode: 'read-only' } }, threadId: childThreadId },
  ]);
});
