/**
 * ADR-0028 step 3b: a worker's outcome and a command session's exit are each
 * one notice on the thread that hears it, and a run takes a notice along its
 * own branch. An edit of the turn that took an outcome takes it again, and an
 * exit outlives a Stop and a restart until a run takes it.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostCommandSessionExit } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  type CallOptions,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const OUTCOME = 'UNIQUE-CHILD-OUTCOME-42';
const REPORT = 'Command sessions that ended by themselves';

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

const deliveries = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) =>
    event.type === 'run.started' && event.delivery
      ? [{ ...event.delivery, runId: event.runId }]
      : []
  );

/** A worker answers OUTCOME; the parent dispatches one on DISPATCH. */
function dispatching(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      if (!toolNames(call).includes('agent-explore')) {
        return stream(text(OUTCOME));
      }
      return stream(
        turn.text.includes('DISPATCH') && !turn.answered
          ? toolCall('agent-explore', { prompt: 'Look.' }, 'call-look')
          : text('Noted.')
      );
    },
  });
}

test('an edit of the turn that took an outcome takes it again', async () => {
  let refused = false;
  // The wake is refused once, so the outcome rides ahead of the next user turn.
  const admit: Parameters<typeof setupChildRunHost>[3] = (platform) => {
    const base = recordingAdmission([])(platform);
    if (!base) {
      throw new Error('The fixture admits every run');
    }
    return async (request) => {
      if (request.prompt === undefined && !refused) {
        refused = true;
        throw new Error('wake refused once');
      }
      return base(request);
    };
  };
  const model = dispatching();
  const harness = await setupChildRunHost(model, cleanup, {}, admit);
  const core = harness.core();
  const first = await harness.start('DISPATCH a worker.');
  await core.idle(harness.threadId);
  expect(refused).toBe(true);
  const second = await harness.start('What did it find?');
  await core.idle(harness.threadId);
  const { runId: edited } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    parentMessageId: first,
    prompt: 'What did it find, again?',
    threadId: harness.threadId,
  });
  await core.idle(harness.threadId);
  const taken = deliveries(await core.read(harness.threadId, 0));
  expect(taken.map(({ runId, via }) => [runId, via])).toEqual([
    [second, 'next-turn'],
    [edited, 'next-turn'],
  ]);
  expect(taken[1]?.via === 'next-turn' && taken[1].ledger).toContain(OUTCOME);
});

/** A host whose platform reports `exit` on demand; its root run blocks on HOLD until released. */
async function exitingHost() {
  const listeners = new Set<(exit: HostCommandSessionExit) => void>();
  const hold = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      if (turn.text.endsWith('HOLD')) {
        await hold.promise;
      }
      return stream(
        text(JSON.stringify(call.prompt).includes(REPORT) ? 'saw report' : 'no report')
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    commandSessionExits: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    personas: [worker],
  });
  const exit = (sessionId: string) => {
    for (const listener of listeners) {
      listener({
        createdAt: 0,
        exitCode: 0,
        exitedAt: 1000,
        outputCursor: 10,
        rootId: 'root-a',
        sessionId,
        signal: null,
        threadId: harness.threadId,
      });
    }
  };
  return { exit, harness, release: () => hold.resolve() };
}

const sessions = (rows: readonly HostLogRow[]) =>
  deliveries(rows).map(({ commandSessions, via }) => [
    via,
    (commandSessions ?? []).map(({ sessionId }) => sessionId),
  ]);

test("after a Stop, an ended session rides the person's next turn instead of waking the thread", async () => {
  const { exit, harness, release } = await exitingHost();
  const core = harness.core();
  const busy = await harness.start('HOLD');
  exit('s1');
  await core.stop({ commandId: randomUUID(), runId: busy, threadId: harness.threadId });
  release();
  await core.idle(harness.threadId);
  await harness.start('Is the build done?');
  await core.idle(harness.threadId);
  expect(sessions(await core.read(harness.threadId, 0))).toEqual([['next-turn', ['s1']]]);
});

test('an ended session no run took survives a restart', async () => {
  const { exit, harness } = await exitingHost();
  await harness.start('HOLD');
  exit('s1');
  await rowsUntil(harness, harness.threadId, ({ event }) => event.type === 'notice.posted', 5000);
  await harness.crash();
  await harness.start('Is the build done?');
  await harness.core().idle(harness.threadId);
  expect(sessions(await harness.core().read(harness.threadId, 0))).toEqual([['next-turn', ['s1']]]);
});
