/**
 * BST-1932 S2: a root persona delegation is a background child (report section
 * 4). Spawning returns at once; the parent wakes once per batch when children
 * return, fail or are cancelled, through a durable delivery recorded on the
 * run it starts, and undelivered results reach the next user turn exactly once.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCalls,
  toolResults,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
const lastUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call).at(-1) ?? '';
const runsOf = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

/**
 * The parent fans out to Alpha and Beta, then holds its own second step until
 * the test releases it. A user turn that names BLOCK keeps its children open.
 */
function fanOutModel(
  options: { readonly blockChildren?: boolean; readonly blockParent?: boolean } = {}
) {
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const names = (call.tools ?? []).map((tool) => tool.name);
      const user = lastUser(call);
      if (names.includes('agent-explore')) {
        if (user.includes(LEDGER)) {
          return stream(text('Parent used the delivered outcomes.'));
        }
        if (user === 'Fan out.') {
          if (call.prompt.some((message) => message.role === 'tool')) {
            if (options.blockParent) {
              return blocked(call);
            }
            await release.promise;
            return stream(text('Parent continues while workers run.'));
          }
          return stream(
            toolCalls([
              ['agent-explore', { prompt: 'ALPHA_TASK: survey alpha.' }, 'fan-1'],
              ['agent-explore', { prompt: 'BETA_TASK: survey beta.' }, 'fan-2'],
            ])
          );
        }
        return stream(text(`Answered: ${user}`));
      }
      if (options.blockChildren) {
        return blocked(call);
      }
      return stream(text(user.startsWith('ALPHA') ? 'Alpha outcome.' : 'Beta outcome.'));
    },
  });
  return { model, release: release.resolve };
}

async function settledChildren(harness: ChildRunHarness, count: number): Promise<void> {
  await expect
    .poll(async () => {
      const threads = await childThreads(harness);
      const finishedRuns = await Promise.all(
        threads.map(async (threadId) =>
          (await harness.core().read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
      );
      return threads.length === count && finishedRuns.every(Boolean);
    })
    .toBe(true);
}

test('background children return at once and wake an idle parent once, batched, with their outcomes', async () => {
  const { model, release } = fanOutModel();
  const harness = await setupChildRunHost(model, cleanup);
  const runId = await harness.start('Fan out.');
  // Both children finish while the parent's own turn is still running.
  await settledChildren(harness, 2);
  release();
  const rows = await rowsUntil(harness, harness.threadId, (row) => {
    const wake = runsOf([row]).find((started) => started.runId !== runId);
    return wake !== undefined;
  });
  const wake = runsOf(rows).find((started) => started.runId !== runId);
  const settled = await rowsUntil(harness, harness.threadId, finished(wake?.runId ?? ''));
  expect(settled.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
  expect(settled.find(finished(wake?.runId ?? ''))?.event).toMatchObject({
    outcome: 'completed',
  });

  // Spawning returned the shipped acknowledgement, never the child's answer.
  const parentSecond = model.doStreamCalls.find(
    (call) => lastUser(call) === 'Fan out.' && call.prompt.some((m) => m.role === 'tool')
  ) as CallOptions;
  const acknowledged = JSON.stringify(toolResults(parentSecond));
  expect(acknowledged.match(/Background task started\./g)).toHaveLength(2);
  expect(acknowledged).not.toContain('outcome.');

  // One wake, one batch: the ledger is its automated input, and the saved
  // outcomes replace the acknowledgements in its model view.
  expect(wake?.delivery).toMatchObject({ via: 'wake' });
  expect(wake?.delivery?.entries.map((entry) => entry.toolCallId).sort()).toEqual([
    'fan-1',
    'fan-2',
  ]);
  const wakeCall = model.doStreamCalls.find((call) =>
    lastUser(call).includes(LEDGER)
  ) as CallOptions;
  expect(lastUser(wakeCall)).toContain(
    `${LEDGER} — 2 total: 2 returned, 0 failed, 0 cancelled, 0 still running.`
  );
  const delivered = JSON.stringify(toolResults(wakeCall));
  expect(delivered).toContain('Alpha outcome.');
  expect(delivered).toContain('Beta outcome.');
  expect(delivered).not.toContain('Background task started.');
  expect(runsOf(settled)).toHaveLength(2);

  for (const threadId of await childThreads(harness)) {
    expect((await harness.core().read(threadId, 0))[0]?.event).toMatchObject({
      origin: { background: true, depth: 1, parentRunId: runId, turnId: runId },
    });
  }
});

test('a crash wakes nothing at boot; the next user turn delivers the interrupted children once', async () => {
  const { model, release } = fanOutModel({ blockChildren: true });
  release();
  const harness = await setupChildRunHost(model, cleanup);
  const runId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  await expect.poll(async () => (await childThreads(harness)).length).toBe(2);
  const calls = model.doStreamCalls.length;
  await harness.crash();
  await settledChildren(harness, 2);
  expect(model.doStreamCalls).toHaveLength(calls);
  expect(runsOf(await harness.core().read(harness.threadId, 0))).toHaveLength(1);

  const next = await harness.start('What happened?');
  const rows = await rowsUntil(harness, harness.threadId, finished(next));
  expect(runsOf(rows).find((started) => started.runId === next)?.delivery).toMatchObject({
    via: 'next-turn',
  });
  const nextCall = model.doStreamCalls.at(-1) as CallOptions;
  const inputs = userTexts(nextCall);
  expect(inputs.at(-1)).toBe('What happened?');
  expect(inputs.at(-2)).toContain(
    `${LEDGER} — 2 total: 0 returned, 2 failed, 0 cancelled, 0 still running.`
  );
  expect(inputs.at(-2)).toContain('Host restarted; child runs are not resumed');

  const after = await harness.start('Anything else?');
  await rowsUntil(harness, harness.threadId, finished(after));
  const afterCall = model.doStreamCalls.at(-1) as CallOptions;
  expect(userTexts(afterCall).filter((input) => input.includes(LEDGER))).toHaveLength(1);
  expect(
    runsOf(await harness.core().read(harness.threadId, 0)).find(
      (started) => started.runId === after
    )?.delivery
  ).toBeUndefined();
});

test("a root Stop stops the turn's background children and wakes nothing", async () => {
  const { model } = fanOutModel({ blockChildren: true, blockParent: true });
  const harness = await setupChildRunHost(model, cleanup);
  const runId = await harness.start('Fan out.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(2);
  await harness.core().stop({ commandId: randomUUID(), runId, threadId: harness.threadId });
  await settledChildren(harness, 2);
  for (const threadId of await childThreads(harness)) {
    expect(
      (await harness.core().read(threadId, 0)).find((row) => row.event.type === 'run.finished')
        ?.event
    ).toMatchObject({ outcome: 'stopped' });
  }
  const rows = await harness.core().read(harness.threadId, 0);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'stopped' });
  expect(runsOf(rows)).toHaveLength(1);

  // A wake would have been admitted ahead of this turn in the same admission queue.
  const next = await harness.start('Why did it stop?');
  const after = await rowsUntil(harness, harness.threadId, finished(next));
  expect(runsOf(after).map((started) => started.delivery?.via)).toEqual([undefined, 'next-turn']);
  expect(userTexts(model.doStreamCalls.at(-1) as CallOptions).at(-2)).toContain(
    `${LEDGER} — 2 total: 0 returned, 0 failed, 2 cancelled, 0 still running.`
  );
});
