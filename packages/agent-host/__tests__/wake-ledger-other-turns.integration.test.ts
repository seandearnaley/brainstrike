/**
 * A wake's ledger names every background invocation still at work, whichever
 * turn dispatched it. A ledger scoped to the delivering turn told the parent
 * "Nothing is still running" while an earlier turn's worker still ran, and the
 * parent dispatched the same work to a second worker.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
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

const LEDGER = 'Background invocations of this turn';
const SLOW = 'SLOW: report when released.';
const FAST = 'FAST: report now.';

/** The newest user message's text, and whether a tool already answered after it. */
function latestTurn(call: CallOptions): { readonly answered: boolean; readonly text: string } {
  const index = call.prompt.findLastIndex((message) => message.role === 'user');
  const latest = call.prompt[index];
  return {
    answered: call.prompt.slice(index).some((message) => message.role === 'tool'),
    text:
      latest?.role === 'user'
        ? latest.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
        : '',
  };
}

test('a wake names a running worker an earlier turn dispatched', { timeout: 20_000 }, async () => {
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const turn = latestTurn(call);
      if (!toolNames(call).includes('agent-explore')) {
        if (turn.text.includes(SLOW)) {
          await release.promise;
        }
        return stream(text('Child report.'));
      }
      if (turn.text.includes(LEDGER) || turn.answered) {
        return stream(text('Noted.'));
      }
      const prompt = turn.text.includes('FIRST') ? SLOW : FAST;
      return stream(toolCall('agent-explore', { prompt }, `call-${prompt.slice(0, 4)}`) as Chunk[]);
    },
  });
  const harness = await setupChildRunHost(model, cleanup);

  // The first turn dispatches a worker that keeps working after the turn ends.
  const first = await harness.start('FIRST: dispatch the slow worker.');
  await rowsUntil(harness, harness.threadId, finished(first), 5000);
  // The second turn's worker reports back while the first turn's still runs.
  const second = await harness.start('SECOND: dispatch the fast worker.');
  await rowsUntil(harness, harness.threadId, finished(second), 5000);
  const wake = (
    await rowsUntil(
      harness,
      harness.threadId,
      (row) => row.event.type === 'run.started' && row.event.delivery?.via === 'wake',
      5000
    )
  ).find((row) => row.event.type === 'run.started' && row.event.delivery?.via === 'wake');
  const ledger = wake?.event.type === 'run.started' ? (wake.event.prompt ?? '') : '';

  expect(ledger).toContain('1 returned, 0 failed, 0 cancelled, 1 still running.');
  expect(ledger).toContain(`still running. Prompt: "${SLOW}"`);
  expect(ledger).not.toContain('Nothing is still running');

  release.resolve();
  await rowsUntil(
    harness,
    harness.threadId,
    (row) =>
      row.event.type === 'run.started' &&
      row.event.delivery?.via === 'wake' &&
      row.event.prompt?.includes(`returned. Prompt: "${SLOW}"`) === true,
    5000
  );
});
