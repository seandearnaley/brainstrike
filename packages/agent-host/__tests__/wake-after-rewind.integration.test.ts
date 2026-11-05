/**
 * A background worker that settles after the person rewound its parent thread:
 * the parent's wake continues the rewound branch, the one the rewind owns as
 * the thread's tip, never the branch the person rewound away from.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  type CallOptions,
  type Chunk,
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

function latest(call: CallOptions): { answered: boolean; text: string } {
  const index = call.prompt.findLastIndex((message) => message.role === 'user');
  const message = call.prompt[index];
  return {
    answered: call.prompt.slice(index).some((m) => m.role === 'tool'),
    text:
      message?.role === 'user'
        ? message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
        : '',
  };
}

const isWake = (row: HostLogRow): boolean =>
  row.event.type === 'run.started' && row.event.delivery?.via === 'wake';

test('a wake after a rewind continues the rewound branch', async () => {
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      if (!toolNames(call).includes('agent-explore')) {
        await release.promise;
        return stream(text('Child report.'));
      }
      if (turn.text.includes('DISPATCH') && !turn.answered) {
        return stream(toolCall('agent-explore', { prompt: 'slow' }, 'call-slow') as Chunk[]);
      }
      return stream(text('Noted.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const core = harness.core();
  const { threadId } = harness;
  const head = await harness.start('Hello.');
  await rowsUntil(harness, threadId, finished(head), 5000);
  const dispatch = randomUUID();
  const { runId: abandoned } = await core.startRun({
    commandId: dispatch,
    modelId: 'scripted',
    prompt: 'DISPATCH the slow worker.',
    threadId,
  });
  await rowsUntil(harness, threadId, finished(abandoned), 5000);
  await expect(
    core.rewinds.rewind({
      commandId: randomUUID(),
      messageId: dispatch,
      mode: 'conversation-only',
      threadId,
    })
  ).resolves.toMatchObject({ status: 'rewound' });

  release.resolve();
  const rows = await rowsUntil(harness, threadId, isWake, 5000);
  const wake = rows.find(isWake)?.event;
  if (wake?.type !== 'run.started') {
    throw new Error('No wake');
  }
  expect(wake.parentMessageId).toBe(head);
});
