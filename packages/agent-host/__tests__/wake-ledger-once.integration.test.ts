/**
 * A worker's outcome reaches its parent's model once. Each wake of a turn is
 * a new message that stays in the thread, and every wake re-sent the full
 * outcome of each worker the turn had already heard from: six wakes carried
 * about 100k characters of repeated outcomes (debug pack 2026-11-04).
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  type CallOptions,
  setupChildRunHost,
  stream,
  text,
  toolCalls,
  toolNames,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
const CONCLUSION = 'FAST_CONCLUSION: the notes name three owners.';
const TAIL = 'FAST_TAIL: nothing else in the notes needs an owner.';
/** A long report that opens with its conclusion, as a worker's usually does. */
const FAST_REPORT = [
  CONCLUSION,
  ...Array.from({ length: 80 }, (_, line) => `Finding ${line + 1} cites notes.md:${line + 1}.`),
  TAIL,
].join(' ');

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test('a later wake of the same turn names an earlier worker without re-sending its outcome', async () => {
  const slow = Promise.withResolvers<void>();
  // The fast worker ends once the parent's last step has begun, so a wake, not
  // that step, first delivers its report.
  const parentLastStep = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (!toolNames(call).includes('agent-explore')) {
        if (user.includes('SLOW_TASK')) {
          await slow.promise;
          return stream(text('Slow outcome.'));
        }
        await parentLastStep.promise;
        return stream(text(FAST_REPORT));
      }
      if (user.endsWith('Delegate.') && !call.prompt.some((message) => message.role === 'tool')) {
        return stream(
          toolCalls([
            ['agent-explore', { prompt: 'FAST_TASK: read the notes.' }, 'once-fast'],
            ['agent-explore', { prompt: 'SLOW_TASK: read the notes.' }, 'once-slow'],
          ])
        );
      }
      parentLastStep.resolve();
      return stream(text('Parent continues.'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  await harness.start('Delegate.');
  /** The ledgers of the parent's wakes that have finished, in commit order. */
  const finishedWakes = async (): Promise<string[]> => {
    const rows = await harness.core().read(harness.threadId, 0);
    const done = new Set(
      rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.runId] : []))
    );
    return rows.flatMap(({ event }) =>
      event.type === 'run.started' && event.delivery?.via === 'wake' && done.has(event.runId)
        ? [event.prompt ?? '']
        : []
    );
  };
  await expect.poll(async () => (await finishedWakes()).length, { timeout: 10_000 }).toBe(1);
  slow.resolve();
  await harness.core().idle(harness.threadId);
  const wakes = await finishedWakes();
  expect(wakes).toHaveLength(2);
  const [first = '', second = ''] = wakes;

  // The wake that first delivers the fast worker carries its whole report.
  expect(first).toContain(FAST_REPORT);
  // The later wake still lists it, by the conclusion its report opens with.
  expect(second).toContain(`${LEDGER} — 2 total: 2 returned`);
  expect(second).toContain('Slow outcome.');
  expect(second).toContain(CONCLUSION);
  expect(second).not.toContain(TAIL);
  // The model reads the report once, from the earlier wake still in its history.
  const lastCall = model.doStreamCalls.findLast((call) =>
    userTexts(call).some((input) => input.includes('Slow outcome.'))
  ) as CallOptions;
  const history = userTexts(lastCall).join('\n');
  expect(occurrences(history, LEDGER)).toBe(2);
  expect(occurrences(history, TAIL)).toBe(1);
});
