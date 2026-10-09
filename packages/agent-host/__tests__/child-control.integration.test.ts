/**
 * BST-1932 S4: controlling one child. Stopping a selected child ends its
 * subtree alone (G12-G16, AT-25); typing into an idle child continues its own
 * conversation under its persona's authority and reports a completed answer
 * to the parent; edits and regenerations deliver pending child results.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostRunAdmissionRequest } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  EXPLORER_INSTRUCTIONS,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  systemText,
  text,
  toolCalls,
  toolNames,
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
const firstUser = (call: Pick<CallOptions, 'prompt'>): string => userTexts(call)[0] ?? '';
const answered = (call: CallOptions): boolean => toolResults(call).length > 0;
const runsOf = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

/** Each child thread keyed by the task it was delegated, once its first run has started. */
async function childrenByTask(harness: ChildRunHarness, count: number) {
  const byTask = new Map<string, { runId: string; threadId: string }>();
  await expect
    .poll(async () => {
      for (const threadId of await childThreads(harness)) {
        const first = runsOf(await harness.core().read(threadId, 0))[0];
        if (first) {
          byTask.set(first.prompt, { runId: first.runId, threadId });
        }
      }
      return byTask.size;
    })
    .toBe(count);
  return byTask;
}

test('stopping a selected child ends it alone; its sibling returns and the parent wakes once with both', async () => {
  const betaGate = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (firstUser(call) === 'Fan out.') {
        if (lastUser(call).includes(LEDGER)) {
          return stream(text('Parent read the ledger.'));
        }
        return stream(
          answered(call as CallOptions)
            ? text('Parent continues.')
            : toolCalls([
                ['agent-explore', { prompt: 'ALPHA_TASK' }, 'fan-1'],
                ['agent-explore', { prompt: 'BETA_TASK' }, 'fan-2'],
              ])
        );
      }
      if (firstUser(call) === 'ALPHA_TASK') {
        return blocked(call);
      }
      await betaGate.promise;
      return stream(text('Beta outcome.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const runId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const children = await childrenByTask(harness, 2);
  const alpha = children.get('ALPHA_TASK');
  const beta = children.get('BETA_TASK');
  if (!(alpha && beta)) {
    throw new Error('Both children must start');
  }
  expect(
    await harness
      .core()
      .stop({ commandId: randomUUID(), runId: alpha.runId, threadId: alpha.threadId })
  ).toEqual({ outcome: 'stopped' });
  betaGate.resolve();
  const betaRows = await rowsUntil(harness, beta.threadId, finished(beta.runId));
  expect(betaRows.find(finished(beta.runId))?.event).toMatchObject({ outcome: 'completed' });
  const rows = await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some((run) => run.delivery?.via === 'wake' && run.prompt.includes('1 cancelled'))
  );
  const wakes = runsOf(rows).filter((run) => run.delivery?.via === 'wake');
  const ledger = wakes.map((run) => run.prompt).join('\n');
  expect(ledger).toContain('cancelled by the user; it has no result');
  expect(ledger).toContain('returned');
  // The root turn was never stopped.
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
});

test('typing into an idle child continues its conversation under its persona and reports the answer once', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (firstUser(call) === 'Explore.') {
        if (
          lastUser(call).includes(LEDGER) ||
          lastUser(call).includes('child_continuation_result')
        ) {
          return stream(text('Parent read the child.'));
        }
        return stream(
          answered(call as CallOptions)
            ? text('Parent continues.')
            : toolCalls([['agent-explore', { prompt: 'EXPLORE_TASK' }, 'e-1']])
        );
      }
      return stream(
        lastUser(call) === 'Dig deeper.' ? text('Deeper finding.') : text('First finding.')
      );
    },
  });
  const requests: HostRunAdmissionRequest[] = [];
  const harness = await setupChildRunHost(model, cleanup, {}, recordingAdmission(requests));
  const runId = await harness.start('Explore.');
  await rowsUntil(harness, harness.threadId, finished(runId));
  const child = (await childrenByTask(harness, 1)).get('EXPLORE_TASK');
  if (!child) {
    throw new Error('The child must start');
  }
  await rowsUntil(harness, child.threadId, finished(child.runId));
  // The first wake delivers the invocation; wait for it before typing.
  await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some((run) => run.delivery?.via === 'wake')
  );
  const { runId: followUp } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Dig deeper.',
    threadId: child.threadId,
  });
  await rowsUntil(harness, child.threadId, finished(followUp));
  // The platform selects for the root thread; the child's own persona narrows it.
  expect(requests.map((request) => request.threadId)).not.toContain(child.threadId);
  const childCall = model.doStreamCalls.find(
    (call) => lastUser(call) === 'Dig deeper.'
  ) as CallOptions;
  // Its own conversation, its persona's instructions and its narrowed tools.
  expect(userTexts(childCall)).toEqual(['EXPLORE_TASK', 'Dig deeper.']);
  expect(JSON.stringify(childCall.prompt)).toContain('First finding.');
  expect(systemText(childCall)).toContain(EXPLORER_INSTRUCTIONS);
  expect(toolNames(childCall)).toEqual(['read_file']);
  // The completed answer reaches the parent as an automated continuation result.
  const rows = await rowsUntil(harness, harness.threadId, (row) =>
    runsOf([row]).some((run) => run.prompt.includes('child_continuation_result'))
  );
  const delivered = runsOf(rows).find((run) => run.prompt.includes('child_continuation_result'));
  expect(delivered?.prompt).toContain('Deeper finding.');
  expect(delivered?.delivery?.entries.map((entry) => entry.childRunId)).toEqual([followUp]);
  await rowsUntil(harness, harness.threadId, finished(delivered?.runId ?? ''));
  expect(runsOf(await harness.core().read(harness.threadId, 0))).toHaveLength(3);
  // A follow-up answered no tool call: the invocation's delivered outcome stays in place.
  const parentLast = model.doStreamCalls
    .filter((call) => firstUser(call) === 'Explore.')
    .at(-1) as CallOptions;
  const results = JSON.stringify(toolResults(parentLast));
  expect(results).toContain('First finding.');
  expect(results).not.toContain('Deeper finding.');
});

test.each(['edit', 'regenerate'] as const)(
  'a %s delivers the pending child results once',
  async (action) => {
    const model = new MockLanguageModelV4({
      doStream: async (call) => {
        if (firstUser(call) === 'ALPHA_TASK') {
          return blocked(call);
        }
        const user = lastUser(call);
        if (user === 'Fan out.' && !answered(call as CallOptions)) {
          return stream(toolCalls([['agent-explore', { prompt: 'ALPHA_TASK' }, 'fan-1']]));
        }
        return stream(text(`Answered: ${user.slice(0, 40)}`));
      },
    });
    const harness = await setupChildRunHost(model, cleanup);
    const runId = await harness.start('Fan out.');
    const rows = await rowsUntil(harness, harness.threadId, finished(runId));
    const userMessageId = rows.flatMap(({ event }) =>
      event.type === 'command.accepted' && event.method === 'run/start' ? [event.commandId] : []
    )[0];
    await expect.poll(async () => (await childThreads(harness)).length).toBe(1);
    // A crash interrupts the child; nothing wakes, so its result is still pending.
    await harness.crash();
    const next =
      action === 'regenerate'
        ? await harness.core().regenerateRun({
            commandId: randomUUID(),
            modelId: 'scripted',
            threadId: harness.threadId,
            userMessageId: userMessageId ?? '',
          })
        : await harness.core().startRun({
            commandId: randomUUID(),
            modelId: 'scripted',
            parentMessageId: null,
            prompt: 'Fan out, edited.',
            threadId: harness.threadId,
          });
    const after = await rowsUntil(harness, harness.threadId, finished(next.runId));
    expect(runsOf(after).find((run) => run.runId === next.runId)?.delivery).toMatchObject({
      via: 'next-turn',
    });
    expect(userTexts(model.doStreamCalls.at(-1) as CallOptions).join('\n')).toContain(
      `${LEDGER} — 1 total: 0 returned, 1 failed`
    );
    expect(runsOf(after).filter((run) => run.delivery !== undefined)).toHaveLength(1);
  }
);
