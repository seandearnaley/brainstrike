/**
 * A tool call whose run a restart interrupted is healed in the next turn's
 * history by its true cause: the app closed or restarted, never "Stop", which
 * would tell the model the person rejected it.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('a tool call a restart interrupted reads as interrupted by the app, not by Stop', async () => {
  const reading = Promise.withResolvers<void>();
  const read = Promise.withResolvers<unknown>();
  const model = new MockLanguageModelV4({
    doStream: async (call) =>
      userTexts(call).some((value) => value.includes('Next.'))
        ? stream(text('Checking again.'))
        : stream(toolCall('read_file', { path: 'notes.md' }, 'read-1')),
  });
  const harness = await setupChildRunHost(model, cleanup, {
    policy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'ask' }, yolo: false }),
    // The approved read is still running when the process dies.
    readFile: () => {
      reading.resolve();
      return read.promise;
    },
  });
  const runId = await harness.start('Read the notes.');
  const rows = await rowsUntil(
    harness,
    harness.threadId,
    (row) => row.event.type === 'interaction.requested',
    5000
  );
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  if (requested?.type !== 'interaction.requested') {
    throw new Error('No approval');
  }
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: requested.interactionId,
    runId,
    threadId: harness.threadId,
  });
  await reading.promise;
  await harness.crash();
  // The dead process's read ends; it can commit nothing more.
  read.resolve({ content: 'late' });
  await rowsUntil(harness, harness.threadId, finished(runId), 5000);

  const next = await harness.start('Next.');
  await rowsUntil(harness, harness.threadId, finished(next), 5000);
  const call = model.doStreamCalls.find((candidate) =>
    userTexts(candidate).some((value) => value.includes('Next.'))
  );
  const healed = JSON.stringify(call?.prompt.filter((message) => message.role === 'tool'));
  expect(healed).toContain('Tool execution was interrupted when the app closed or restarted.');
  expect(healed).not.toContain('Stop');
});
