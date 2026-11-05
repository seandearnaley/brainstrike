/**
 * A command session a run started that ends by itself reaches a model: the
 * thread that started it wakes, a busy thread hears it when its run ends, and
 * a worker that already returned hands it to its parent. Before this, a
 * worker's background validation finished unseen and the parent went idle on
 * "still running" (debug pack 2026-11-04).
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { hostChildCallSign } from '../src/child-presentation.js';
import type { HostCommandSessionExit } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  type CallOptions,
  type ChildRunHarness,
  type Chunk,
  childThreads,
  finished,
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

const REPORT = 'Command sessions that ended by themselves';

function latestUserText(call: CallOptions): string {
  const latest = call.prompt.findLast((message) => message.role === 'user');
  return latest?.role === 'user'
    ? latest.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    : '';
}
function answered(call: CallOptions): boolean {
  const index = call.prompt.findLastIndex((message) => message.role === 'user');
  return call.prompt.slice(index).some((message) => message.role === 'tool');
}

/** A host whose platform reports session exits the test emits. */
async function exitHost(hold?: Promise<void>) {
  const listeners = new Set<(exit: HostCommandSessionExit) => void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-worker')) {
        return stream(text('Started a session and returned.'));
      }
      const latest = latestUserText(call);
      if (latest.includes('HOLD') && hold) {
        await hold;
      }
      if (latest.includes('DELEGATE') && !answered(call)) {
        return stream(
          toolCall('agent-worker', { prompt: 'Start the build.' }, 'call-1') as Chunk[]
        );
      }
      return stream(text(latest.includes(REPORT) ? 'Reading its output.' : 'Done.'));
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
  const exit = (threadId: string, exitCode = 1): void => {
    for (const listener of listeners) {
      listener({
        createdAt: 1000,
        exitCode,
        exitedAt: 66_000,
        outputCursor: 9000,
        rootId: 'root-a',
        sessionId: 'command-session-1',
        signal: null,
        threadId,
      });
    }
  };
  return { exit, harness };
}

const wakeFor = (sessionId: string) => (row: HostLogRow) =>
  row.event.type === 'run.started' &&
  row.event.delivery?.via === 'wake' &&
  row.event.delivery.commandSessions?.some((session) => session.sessionId === sessionId) === true;

/** The thread's committed rows once it and its workers have nothing left in flight. */
async function quiet(harness: ChildRunHarness): Promise<HostLogRow[]> {
  await harness.core().idle(harness.threadId);
  return harness.core().read(harness.threadId, 0);
}

async function wakeRun(harness: ChildRunHarness) {
  const rows = await quiet(harness);
  const started = rows.find(wakeFor('command-session-1'))?.event;
  if (started?.type !== 'run.started') {
    throw new Error('No wake reported the session');
  }
  expect(rows.some(finished(started.runId))).toBe(true);
  return started;
}

test('a session the root started that exits by itself wakes the root', async () => {
  const { exit, harness } = await exitHost();
  await harness.start('Run the tests in the background.');
  await quiet(harness);

  exit(harness.threadId);

  const wake = await wakeRun(harness);
  expect(wake.delivery).toMatchObject({
    commandSessions: [{ exitCode: 1, sessionId: 'command-session-1' }],
    entries: [],
  });
  expect(wake.prompt).toContain(
    'command-session-1 (root root-a), started by you, exited with code 1 after 1m 5s.'
  );
  // The read it names is the inspector's own input, root included.
  expect(wake.prompt).toContain(
    'brainstrike_inspectCommandSessions {"operation":{"action":"read","cursor":5000,"sessionId":"command-session-1"},"root":"root-a"}.'
  );
});

test('a busy root hears a session that ended once its run ends', async () => {
  const release = Promise.withResolvers<void>();
  const { exit, harness } = await exitHost(release.promise);
  const busy = await harness.start('HOLD while the build runs.');

  exit(harness.threadId);
  const during = await harness.core().read(harness.threadId, 0);
  expect(during.filter((row) => row.event.type === 'run.started')).toHaveLength(1);

  release.resolve();
  const wake = await wakeRun(harness);
  expect(wake.parentMessageId).toBe(busy);
});

test("a Stop wakes nothing; the person's next turn carries the session", async () => {
  const release = Promise.withResolvers<void>();
  const { exit, harness } = await exitHost(release.promise);
  const busy = await harness.start('HOLD while the build runs.');
  exit(harness.threadId);

  await harness.core().stop({ commandId: randomUUID(), runId: busy, threadId: harness.threadId });
  release.resolve();
  // Nothing woke: once the thread is quiet, the stopped run is its only run.
  const stopped = await quiet(harness);
  expect(stopped.filter((row) => row.event.type === 'run.started')).toHaveLength(1);
  expect(stopped.some(finished(busy))).toBe(true);

  const next = await harness.start('Is the build done?');
  const rows = await quiet(harness);
  const started = rows.filter((row) => row.event.type === 'run.started').map((row) => row.event);
  expect(started).toHaveLength(2);
  expect(started[1]).toMatchObject({
    delivery: { commandSessions: [{ sessionId: 'command-session-1' }], via: 'next-turn' },
    runId: next,
  });
  // The model answering the person reads the report in that same turn.
  const answering = harness.model.doStreamCalls.find((call) =>
    latestUserText(call).includes('Is the build done?')
  );
  expect(answering && latestUserText(answering)).toContain(REPORT);
});

test('a worker that returned hands its session to the parent', async () => {
  const { exit, harness } = await exitHost();
  await harness.start('DELEGATE the build.');
  // The worker returns, and the parent's wake for its result ends.
  await quiet(harness);
  const [child] = await childThreads(harness);
  if (!child) {
    throw new Error('No worker was delegated');
  }

  exit(child);

  const wake = await wakeRun(harness);
  expect(wake.prompt).toContain(`started by subagent ${hostChildCallSign(child)}, exited`);
});
