import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { memoryVectorHost } from './fixtures/memory-vector-host.js';

let receipt:
  | {
      runSettledAtCancellation: boolean;
      retiredBeforeRelease: boolean;
      ownerAborted: boolean;
      rootHeldBeforeRelease: boolean;
      retired: boolean;
      retained: number;
      rootExists: boolean;
      testSignalAborted: boolean;
    }
  | undefined;

/**
 * The Vitest test timeout is the watchdog under test. Only its value is
 * narrowed for this case: it must fire while the run is held, after setup
 * (about 3 s on a loaded host). A watchdog that fires before the hold fails
 * the receipt assertions below instead of passing.
 */
const HELD_RUN_WATCHDOG_MS = 15_000;

test.fails('the existing test watchdog retires a held run and joins physical fixture cleanup', {
  timeout: HELD_RUN_WATCHDOG_MS,
}, async ({ signal, onTestFinished }) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retired = false;
  let runSettled = false;
  let retiredBeforeRelease = true;
  let ownerAborted = false;
  let rootHeldBeforeRelease = false;
  // Register before construction: the fixture's supported finish hook joins
  // cancellation first, then this observer checks its actual physical receipt.
  onTestFinished(async () => {
    await nextTurn();
    const runSettledAtCancellation = runSettled;
    await host.close();
    receipt = {
      ownerAborted,
      retained: host.retained(),
      retired,
      retiredBeforeRelease,
      rootExists: existsSync(host.root),
      rootHeldBeforeRelease,
      runSettledAtCancellation,
      testSignalAborted: signal.aborted,
    };
    console.error('Watchdog physical retirement receipt:', JSON.stringify(receipt));
  });
  const host = await memoryVectorHost({
    beforeEmbedding: async (values, nativeSignal) => {
      if (values.includes('Host run completed.')) {
        if (!nativeSignal) {
          throw new Error('Held embedding requires the actual native owner signal');
        }
        nativeSignal.addEventListener(
          'abort',
          () => {
            retiredBeforeRelease = retired;
            ownerAborted = nativeSignal.aborted;
            rootHeldBeforeRelease = existsSync(host.root);
            // A deliberately uncooperative raw provider retires only after the
            // owner is cancelled; no added timer or cancellation race.
            void nextTurn().then(() => release.resolve());
          },
          { once: true }
        );
        entered.resolve();
        await release.promise;
        retired = true;
      }
    },
    realIndexer: true,
    semanticScope: 'thread',
  });
  const { threadId } = await host.core.startThread({ commandId: randomUUID() });
  const run = host.run(threadId, 'Paris watchdog source.').finally(() => {
    runSettled = true;
  });
  run.catch(() => undefined);
  await entered.promise;
  try {
    await run;
  } finally {
    await host.close();
  }
});

test('watchdog receipt proves cancellation released the wait and joined the original owner', () => {
  expect(receipt).toEqual({
    ownerAborted: true,
    retained: 0,
    retired: true,
    retiredBeforeRelease: false,
    rootExists: false,
    rootHeldBeforeRelease: true,
    runSettledAtCancellation: true,
    testSignalAborted: true,
  });
});
