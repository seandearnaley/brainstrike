/**
 * ADR-0028 step 3b: a worker's outcome and a command session's exit are each
 * one notice on the thread that hears it, and a run takes a notice along its
 * own branch. An edit of the turn that took an outcome takes it again, and an
 * exit outlives a Stop and a restart until a run takes it.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostCommandSessionExit } from '../src/ports.ts';
import type { HostLogRow } from '../src/protocol.ts';
import {
  type CallOptions,
  childThreads,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  toolResults,
  worker,
} from './fixtures/child-run-host.ts';

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

/**
 * A worker answers OUTCOME; the parent dispatches one on DISPATCH. The worker
 * answers once the parent's last step has begun, so its report waits for the
 * parent's end instead of reaching that step.
 */
function dispatching(): MockLanguageModelV4 {
  const lastStep = Promise.withResolvers<void>();
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      if (!toolNames(call).includes('agent-explore')) {
        await lastStep.promise;
        return stream(text(OUTCOME));
      }
      if (turn.text.includes('DISPATCH') && !turn.answered) {
        return stream(toolCall('agent-explore', { prompt: 'Look.' }, 'call-look'));
      }
      lastStep.resolve();
      return stream(text('Noted.'));
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

test("a running thread takes a worker's report at its next step, and nothing wakes it after", async () => {
  // The parent dispatches a worker, then reads a file that returns only once
  // the worker's report is posted, so the report lands while the parent works.
  let harness: Awaited<ReturnType<typeof setupChildRunHost>> | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        return stream(text(OUTCOME));
      }
      const answered = toolResults(call).length;
      if (answered === 0) {
        return stream(toolCall('agent-explore', { prompt: 'Look.' }, 'call-look'));
      }
      if (answered === 1) {
        return stream(toolCall('read_file', { path: 'notes.md' }, 'call-read'));
      }
      return stream(text(JSON.stringify(call.prompt).includes(OUTCOME) ? 'took it' : 'missed it'));
    },
  });
  harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      if (!harness) {
        throw new Error('The host is not set up');
      }
      await rowsUntil(
        harness,
        harness.threadId,
        ({ event }) => event.type === 'notice.posted',
        5000
      );
      return { content: 'notes' };
    },
  });
  const core = harness.core();
  const parent = await harness.start('Look, then read the notes.');
  await core.idle(harness.threadId);
  const rows = await core.read(harness.threadId, 0);
  const taken = rows.flatMap(({ event }) =>
    event.type === 'model.messages' && event.delivery
      ? [[event.runId, event.delivery.entries.map(({ outcome }) => outcome.includes(OUTCOME))]]
      : []
  );
  expect(taken).toEqual([[parent, [true]]]);
  expect(JSON.stringify(rows.filter(({ event }) => event.type === 'model.step').at(-1))).toContain(
    'took it'
  );
  // The report was taken on this branch: neither a wake nor the next turn takes it again.
  await harness.start('Anything new?');
  await core.idle(harness.threadId);
  expect(deliveries(await core.read(harness.threadId, 0))).toEqual([]);
});

test('an exit that commits on a child whose run just ended goes on to its parent, never waking the child', async () => {
  const listeners = new Set<(exit: HostCommandSessionExit) => void>();
  const childWorking = Promise.withResolvers<void>();
  const childRelease = Promise.withResolvers<void>();
  const noticeHeld = Promise.withResolvers<void>();
  const noticeRelease = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latest(call);
      const first = call.prompt.find((message) => message.role === 'user');
      // The worker's thread opens with its task; the root's with the person's.
      if (JSON.stringify(first).includes('Start the build.')) {
        childWorking.resolve();
        await childRelease.promise;
        return stream(text('Started a session and returned.'));
      }
      return stream(
        turn.text.includes('DELEGATE') && !turn.answered
          ? toolCall('agent-worker', { prompt: 'Start the build.' }, 'call-1')
          : text(JSON.stringify(call.prompt).includes(REPORT) ? 'saw report' : 'Done.')
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
    // The exit's notice commits only after the child's run has ended and handed on.
    holdAppend: async (items) => {
      const exitNotice = items.some(({ event }) => {
        const posted = event as HostLogRow['event'];
        return (
          posted.type === 'notice.posted' &&
          posted.notice.kind === 'command-session' &&
          posted.notice.handedOnFrom === undefined
        );
      });
      if (exitNotice) {
        noticeHeld.resolve();
        await noticeRelease.promise;
      }
    },
    personas: [worker],
  });
  await harness.start('DELEGATE the build.');
  await childWorking.promise;
  const [child = ''] = await childThreads(harness);
  for (const listener of listeners) {
    listener({
      createdAt: 0,
      exitCode: 0,
      exitedAt: 1000,
      outputCursor: 10,
      rootId: 'root-a',
      sessionId: 's1',
      signal: null,
      threadId: child,
    });
  }
  await noticeHeld.promise;
  childRelease.resolve();
  await rowsUntil(harness, child, ({ event }) => event.type === 'run.finished', 5000);
  noticeRelease.resolve();
  await harness.core().idle(harness.threadId);
  const childRuns = (await harness.core().read(child, 0)).filter(
    ({ event }) => event.type === 'run.started'
  );
  expect(childRuns).toHaveLength(1);
  // The root hears the session once, by a wake of its own (beside the child's report).
  const heard = sessions(await harness.core().read(harness.threadId, 0)).filter(
    ([, ids]) => (ids?.length ?? 0) > 0
  );
  expect(heard).toEqual([['wake', ['s1']]]);
});
