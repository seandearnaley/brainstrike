/**
 * BST-2178: human input typed into a RUNNING follow-up, a run a person typed
 * into an idle background child after its invocation was delivered. As for the
 * invocation (child-input.integration.test.ts, BST-2173), the follow-up ends
 * after its step in flight and the input runs next; the follow-up reports to
 * the parent once, in the same delivery as the run that took its input.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { committedRunIdentity } from '../src/committed-identities.js';
import type { HostChildDeliveryEntry, HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type ChildRunHarness,
  childThreads,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
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

const FOLLOW_UP = 'FOLLOW_UP_3: which file next?';
const INPUT = 'HUMAN_INPUT_7: check the date too.';
const SECOND_INPUT = 'HUMAN_INPUT_8: and who wrote them.';
const LEDGER = 'Background invocations of this turn';
const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const finishedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event] : []));
const reported = (entries: readonly HostChildDeliveryEntry[] | undefined) =>
  entries?.map(({ childRunId, followUp, state }) => ({ childRunId, followUp, state }));
const hold = () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});

/**
 * A person types a follow-up into an idle background child (ALPHA, already
 * delivered) while its sibling (BETA) still runs, then gives that follow-up
 * human input. Each read_file holds until released, so the input lands during
 * the step in flight; when `chained`, the input's run reads too and takes a
 * second input. The last input's run waits for `lastRun.release` when `last`
 * is held, or stays open until it is aborted.
 */
async function followUpTakingInput(last: 'held' | 'blocks', chained = false) {
  const reads = [hold(), hold()];
  const lastRun = hold();
  let read = 0;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const users = userTexts(call);
      if (toolNames(call).includes('agent-explore')) {
        if (users.join('\n').includes(LEDGER)) {
          return stream(text('Parent read the children.'));
        }
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent continues.'))
          : stream(
              toolCalls([
                ['agent-explore', { prompt: 'ALPHA' }, 'alpha'],
                ['agent-explore', { prompt: 'BETA' }, 'beta'],
              ])
            );
      }
      const prompt = users.at(-1);
      if (users[0] === 'BETA') {
        return blocked(call);
      }
      if (prompt === 'ALPHA') {
        return stream(text('Alpha finding.'));
      }
      if (prompt === FOLLOW_UP || (chained && prompt === INPUT)) {
        return stream(toolCall('read_file', { path: 'notes.md' }, `read-${read}`));
      }
      lastRun.entered.resolve();
      if (last === 'blocks') {
        return blocked(call);
      }
      await lastRun.release.promise;
      return stream(text('Child read the input.'));
    },
  });
  let heldWake: { entered: () => void; until: Promise<void> } | undefined;
  const teardown = Promise.withResolvers<void>();
  const harness = await setupChildRunHost(
    model,
    cleanup,
    {
      readFile: async () => {
        const held = reads[read++];
        if (!held) {
          throw new Error('Only the follow-up and the input run read');
        }
        held.entered.resolve();
        await held.release.promise;
        return { content: 'notes' };
      },
    },
    (platform) => {
      const admit = recordingAdmission([])(platform);
      if (!admit) {
        throw new Error('The recording admission must admit runs');
      }
      return async (request) => {
        const wake = request.prompt === undefined ? heldWake : undefined;
        if (wake) {
          heldWake = undefined;
          wake.entered();
          await Promise.race([wake.until, teardown.promise]);
        }
        return admit(request);
      };
    }
  );
  cleanup.push(async () => {
    teardown.resolve();
    for (const held of [...reads, lastRun]) {
      held.release.resolve();
    }
  });
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const children = await Promise.all(
    (await childThreads(harness)).map(async (threadId) => ({
      run: startedRuns(await harness.core().read(threadId, 0))[0],
      threadId,
    }))
  );
  const alpha = children.find(({ run }) => run?.prompt === 'ALPHA');
  const beta = children.find(({ run }) => run?.prompt === 'BETA');
  if (!(alpha?.run && beta?.run)) {
    throw new Error('Both delegated runs must be committed');
  }
  const wakeRuns = async () =>
    startedRuns(await harness.core().read(harness.threadId, 0)).filter(
      ({ delivery }) => delivery?.via === 'wake'
    );
  // Alpha's invocation is delivered, beside its running sibling, before the person types.
  await expect.poll(async () => (await wakeRuns()).length, { timeout: 5000 }).toBe(1);
  const [delivered] = await wakeRuns();
  await rowsUntil(harness, harness.threadId, finished(delivered?.runId ?? ''), 5000);
  expect(reported(delivered?.delivery?.entries)).toEqual([
    { childRunId: alpha.run.runId, followUp: undefined, state: 'returned' },
  ]);
  const input = (runId: string, prompt: string) =>
    expect(
      harness.core().input({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt,
        runId,
        threadId: alpha.threadId,
      })
    ).resolves.toEqual({ accepted: true });
  const { runId: followUp } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: FOLLOW_UP,
    threadId: alpha.threadId,
  });
  await reads[0]?.entered.promise;
  await input(followUp, INPUT);
  /** Alpha's runs after its delivered invocation: the follow-up, then each input's run. */
  const alphaRuns = async () =>
    startedRuns(await harness.core().read(alpha.threadId, 0))
      .slice(1)
      .map(({ runId }) => runId);
  return {
    alpha,
    alphaRuns,
    beta,
    harness,
    /** Holds the next wake's admission until `until`; resolves once that wake is admitted. */
    holdNextWake: (until: Promise<void>) => {
      const entered = Promise.withResolvers<void>();
      heldWake = { entered: entered.resolve, until };
      return entered.promise;
    },
    input,
    lastRun,
    reads,
    stopBeta: () =>
      expect(
        harness
          .core()
          .stop({ commandId: randomUUID(), runId: beta.run?.runId ?? '', threadId: beta.threadId })
      ).resolves.toEqual({ outcome: 'stopped' }),
    wakeRuns,
  };
}

/** The parent's runs that delivered a follow-up's report, in commit order. */
async function followUpDeliveries(harness: ChildRunHarness) {
  return startedRuns(await harness.core().read(harness.threadId, 0)).filter(({ delivery }) =>
    delivery?.entries.some(({ followUp }) => followUp)
  );
}

test.each([
  'before the input run starts',
  'while the input run runs',
  "while a second input's run runs",
] as const)(
  "a follow-up that took human input reports with its input's run when a sibling's wake lands %s",
  async (moment) => {
    const chained = moment === "while a second input's run runs";
    const child = await followUpTakingInput('held', chained);
    const { harness, lastRun, reads } = child;
    if (moment === 'before the input run starts') {
      // The sibling's wake is admitted once the follow-up's end is committed:
      // between that end and its input run's start, which queues behind it.
      const [followUp = ''] = await child.alphaRuns();
      const ended = Promise.withResolvers<void>();
      const unsubscribe = harness.core().onCommitted((row) => {
        if (finished(followUp)(row)) {
          ended.resolve();
        }
      });
      cleanup.push(async () => unsubscribe());
      const admitted = child.holdNextWake(ended.promise);
      lastRun.release.resolve();
      await child.stopBeta();
      await admitted;
      reads[0]?.release.resolve();
    } else {
      reads[0]?.release.resolve();
      if (chained) {
        await reads[1]?.entered.promise;
        const [, inputRun = ''] = await child.alphaRuns();
        await child.input(inputRun, SECOND_INPUT);
        reads[1]?.release.resolve();
      }
      await lastRun.entered.promise;
      await child.stopBeta();
      await expect.poll(async () => (await child.wakeRuns()).length, { timeout: 5000 }).toBe(2);
      lastRun.release.resolve();
    }

    // Alpha's invocation, its follow-up and each input's run all completed.
    const ended = chained ? 4 : 3;
    await expect
      .poll(
        async () =>
          finishedRuns(await harness.core().read(child.alpha.threadId, 0)).map(
            ({ outcome }) => outcome
          ),
        { timeout: 5000 }
      )
      .toEqual(Array.from({ length: ended }, () => 'completed'));
    const alphaRuns = await child.alphaRuns();
    const followUpEntries = async () =>
      (await followUpDeliveries(harness)).flatMap(({ delivery }) =>
        (delivery?.entries ?? []).filter(({ followUp }) => followUp)
      );
    await expect
      .poll(async () => (await followUpEntries()).length, { timeout: 5000 })
      .toBe(alphaRuns.length);
    // Beta's wake carries Beta alone: Alpha's follow-up was still at work on the person's input.
    const [, betaWake] = await child.wakeRuns();
    expect(betaWake?.delivery?.entries.map(({ childThreadId }) => childThreadId)).toEqual([
      child.beta.threadId,
    ]);
    // One later wake carries the follow-up with every run that took its input.
    const [carrying, ...more] = await followUpDeliveries(harness);
    expect(more).toEqual([]);
    expect(carrying?.delivery?.via).toBe('wake');
    expect(reported(carrying?.delivery?.entries)).toEqual(
      alphaRuns.map((childRunId) => ({ childRunId, followUp: true, state: 'returned' }))
    );
    expect(carrying?.prompt).toContain('Child read the input.');
  }
);

test("a host closed while a follow-up's input run runs delivers both runs once, at the next user turn after restart", async () => {
  const child = await followUpTakingInput('blocks');
  const { harness, lastRun, reads } = child;
  reads[0]?.release.resolve();
  await lastRun.entered.promise;
  await harness.core().close();
  // Restart: the follow-up's accepted input folds from its committed run/input;
  // the run taking it was interrupted, so nothing is still at work.
  await harness.crash();
  const alphaRuns = await child.alphaRuns();
  const rows = await harness.core().read(child.alpha.threadId, 0);
  expect(finishedRuns(rows).map(({ outcome }) => outcome)).toEqual([
    'completed',
    'completed',
    'interrupted',
  ]);
  const next = await harness.start('Next.');
  await rowsUntil(harness, harness.threadId, finished(next), 5000);
  const [turn, ...more] = await followUpDeliveries(harness);
  expect(more).toEqual([]);
  expect(turn?.runId).toBe(next);
  expect(turn?.delivery?.via).toBe('next-turn');
  expect(
    reported(
      turn?.delivery?.entries.filter(({ childThreadId }) => childThreadId === child.alpha.threadId)
    )
  ).toEqual([
    { childRunId: alphaRuns[0], followUp: true, state: 'returned' },
    { childRunId: alphaRuns[1], followUp: true, state: 'failed' },
  ]);
  // A later user turn delivers nothing again.
  const again = await harness.start('Again.');
  const after = await rowsUntil(harness, harness.threadId, finished(again), 5000);
  expect(startedRuns(after).find(({ runId }) => runId === again)?.delivery).toBeUndefined();
  // The input was not replayed: the follow-up's input ran once, before the restart.
  expect(await child.alphaRuns()).toEqual(alphaRuns);
});

test("a stopped follow-up's refused input wakes nothing; a retry of that input reports on its own", async () => {
  const child = await followUpTakingInput('held');
  const { harness, lastRun, reads } = child;
  const [followUp = ''] = await child.alphaRuns();
  const stopped = harness
    .core()
    .stop({ commandId: randomUUID(), runId: followUp, threadId: child.alpha.threadId });
  reads[0]?.release.resolve();
  await expect(stopped).resolves.toEqual({ outcome: 'stopped' });
  // A stopped follow-up never reports, so neither does the input it refused.
  await expect
    .poll(
      async () =>
        finishedRuns(await harness.core().read(child.alpha.threadId, 0)).map(
          ({ outcome }) => outcome
        ),
      { timeout: 5000 }
    )
    .toEqual(['completed', 'stopped', 'failed']);
  const [, refused = ''] = await child.alphaRuns();
  lastRun.release.resolve();
  const { userMessageId } = committedRunIdentity(
    await harness.core().read(child.alpha.threadId, 0),
    refused
  );
  const { runId: retried } = await harness.core().regenerateRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId: child.alpha.threadId,
    userMessageId,
  });
  await rowsUntil(harness, child.alpha.threadId, finished(retried), 5000);
  // The completed retry is an ordinary follow-up: it reports alone, not held for the stopped run.
  let carrying: Awaited<ReturnType<typeof followUpDeliveries>> = [];
  await expect
    .poll(
      async () => {
        carrying = await followUpDeliveries(harness);
        const last = carrying.at(-1);
        return (
          last !== undefined &&
          (await harness.core().read(harness.threadId, 0)).some(finished(last.runId))
        );
      },
      { timeout: 5000 }
    )
    .toBe(true);
  expect(carrying.map(({ delivery }) => reported(delivery?.entries))).toEqual([
    [{ childRunId: retried, followUp: true, state: 'returned' }],
  ]);
  expect(carrying[0]?.prompt).toContain('Child read the input.');
});
