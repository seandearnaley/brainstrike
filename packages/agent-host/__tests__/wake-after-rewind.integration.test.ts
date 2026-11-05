/**
 * A background worker that settles after the person rewound its parent thread:
 * the parent's wake continues the rewound branch, the one the rewind owns as
 * the thread's tip, never the branch the person rewound away from. Once a new
 * turn starts on that branch, the rewind no longer owns the tip.
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

function delegatingModel(release: Promise<void>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      if (!toolNames(call).includes('agent-explore')) {
        await release;
        return stream(text('Child report.'));
      }
      if (turn.text.includes('DISPATCH') && !turn.answered) {
        return stream(toolCall('agent-explore', { prompt: 'slow' }, 'call-slow') as Chunk[]);
      }
      return stream(text('Noted.'));
    },
  });
}

async function wakeOf(harness: Awaited<ReturnType<typeof setupChildRunHost>>) {
  const rows = await rowsUntil(harness, harness.threadId, isWake, 5000);
  const wake = rows.find(isWake)?.event;
  if (wake?.type !== 'run.started') {
    throw new Error('No wake');
  }
  return wake;
}

test('a wake after a rewind continues the rewound branch', async () => {
  const release = Promise.withResolvers<void>();
  const harness = await setupChildRunHost(delegatingModel(release.promise), cleanup);
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
  expect((await wakeOf(harness)).parentMessageId).toBe(head);
});

test.each([
  ['an earlier turn', 1],
  ['the start', 0],
])(
  'a worker dispatched by the turn after a rewind to %s wakes that turn',
  async (_target, kept) => {
    const release = Promise.withResolvers<void>();
    const harness = await setupChildRunHost(delegatingModel(release.promise), cleanup);
    const core = harness.core();
    const { threadId } = harness;
    const prompts = ['Hello.', 'Second.'];
    const sent: string[] = [];
    for (const prompt of prompts) {
      const commandId = randomUUID();
      sent.push(commandId);
      const { runId } = await core.startRun({ commandId, modelId: 'scripted', prompt, threadId });
      await rowsUntil(harness, threadId, finished(runId), 5000);
    }
    const rewound = await core.rewinds.rewind({
      commandId: randomUUID(),
      messageId: sent[kept] ?? '',
      mode: 'conversation-only',
      threadId,
    });
    if (rewound.status !== 'rewound') {
      throw new Error(`Rewind ${rewound.status}`);
    }
    const turn = await harness.start('DISPATCH the slow worker.');
    await rowsUntil(harness, threadId, finished(turn), 5000);
    // The new turn ends the rewind: it can no longer be redone.
    await expect(
      core.rewinds.redo({ commandId: randomUUID(), rewindId: rewound.rewindId, threadId })
    ).rejects.toMatchObject({ failure: { code: 'rewind.redo-unavailable' } });

    release.resolve();
    expect((await wakeOf(harness)).parentMessageId).toBe(turn);
  }
);
