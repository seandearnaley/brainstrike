/**
 * Audit TW-3: an edit, a regenerate or a rewind leaves the turns below the
 * message it forks from, and each left turn ends with its workers, so no
 * worker keeps writing the checkout beside the new branch. Sending on from the
 * turn keeps it.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  childThreads,
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

/** The newest user message's text, and whether a tool result answered it. */
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

const outcomes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []));
const wakes = (rows: readonly HostLogRow[]) =>
  rows.filter(({ event }) => event.type === 'run.started' && event.delivery?.via === 'wake');

/** "Hello.", then a turn whose background worker is still working. */
async function workingTurn() {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return blocked(call);
      }
      const turn = latest(call);
      return stream(
        turn.text.includes('DISPATCH') && !turn.answered
          ? toolCall('agent-explore', { prompt: 'Look.' }, 'call-look')
          : text('Noted.')
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const { threadId } = harness;
  const core = harness.core();
  const head = await harness.start('Hello.');
  await core.idle(threadId);
  const message = randomUUID();
  const { runId: turn } = await core.startRun({
    commandId: message,
    modelId: 'scripted',
    prompt: 'DISPATCH a worker.',
    threadId,
  });
  await rowsUntil(harness, threadId, finished(turn), 5000);
  const [child = ''] = await childThreads(harness);
  /** The worker's outcomes: a Stop of its turn has joined it by the time the command replies. */
  const worker = async () => outcomes(await core.read(child, 0));
  /** Whether the parent was woken, once the thread is quiet. */
  const woken = async () => {
    await core.idle(threadId);
    return wakes(await core.read(threadId, 0)).length > 0;
  };
  return { child, core, harness, head, message, threadId, turn, woken, worker };
}

test("editing a message ends its turn's worker before the edited branch runs", async () => {
  const { core, head, threadId, woken, worker } = await workingTurn();
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: head,
    prompt: 'Edited.',
    threadId,
  });
  expect(await worker()).toEqual(['stopped']);
  expect(await woken()).toBe(false);
  expect((await core.read(threadId, 0)).find(finished(runId))?.event).toMatchObject({
    outcome: 'completed',
  });
});

test("regenerating a message ends its earlier answer's worker", async () => {
  const { core, message, threadId, worker } = await workingTurn();
  await core.regenerateRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId,
    userMessageId: message,
  });
  expect(await worker()).toEqual(['stopped']);
});

test("a rewind ends the rewound turn's worker, so nothing wakes the branch it left", async () => {
  const { core, message, threadId, woken, worker } = await workingTurn();
  await expect(
    core.rewinds.rewind({
      commandId: randomUUID(),
      messageId: message,
      mode: 'conversation-only',
      threadId,
    })
  ).resolves.toMatchObject({ status: 'rewound' });
  expect(await worker()).toEqual(['stopped']);
  expect(await woken()).toBe(false);
});

test('sending on from the turn keeps its worker working', async () => {
  const { core, threadId, turn, worker } = await workingTurn();
  await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: turn,
    prompt: 'And then?',
    threadId,
  });
  expect(await worker()).toEqual([]);
});

test('a replayed edit stops no worker the person started since', async () => {
  const harness = await workingTurn();
  const { child, core, head, threadId } = harness;
  const edit = {
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: head,
    prompt: 'Edited.',
    threadId,
  };
  const { runId } = await core.startRun(edit);
  await core.idle(threadId);
  const { runId: next } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'DISPATCH another.',
    threadId,
  });
  await rowsUntil(harness.harness, threadId, finished(next), 5000);

  // The client retries the edit it already sent: the host answers it again and ends nothing.
  await expect(core.startRun(edit)).resolves.toEqual({ runId });
  const [later = ''] = (await childThreads(harness.harness)).filter((id) => id !== child);
  expect(outcomes(await core.read(later, 0))).toEqual([]);
});
