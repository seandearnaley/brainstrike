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
const EDITED = 'HUMAN_INPUT_9: check the year instead.';
const BUSY = 'Busy: hold the parent turn.';
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
 * is held, or stays open until it is aborted. A regenerate of that run, or an
 * edit, stays open until it is aborted; a BUSY parent turn waits for
 * `busy.release`.
 */
async function followUpTakingInput(last: 'held' | 'blocks', chained = false) {
  const reads = [hold(), hold()];
  const lastRun = hold();
  const busy = hold();
  const replaced = Promise.withResolvers<void>();
  let read = 0;
  let lastCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const users = userTexts(call);
      if (toolNames(call).includes('agent-explore')) {
        if (users.at(-1) === BUSY) {
          busy.entered.resolve();
          await busy.release.promise;
          return stream(text('Parent was busy.'));
        }
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
      lastCalls += 1;
      if (prompt === EDITED || lastCalls > 1) {
        replaced.resolve();
        return blocked(call);
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
    for (const held of [...reads, lastRun, busy]) {
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
  /** A person's replacement of a committed user message in Alpha: Retry, or Edit from `parent`. */
  const replace = async (how: 'regenerate' | 'edit', runId: string, parent: string) => {
    const command = { commandId: randomUUID(), modelId: 'scripted', threadId: alpha.threadId };
    if (how === 'edit') {
      return (
        await harness.core().startRun({ ...command, parentMessageId: parent, prompt: EDITED })
      ).runId;
    }
    const { userMessageId } = committedRunIdentity(
      await harness.core().read(alpha.threadId, 0),
      runId
    );
    return (await harness.core().regenerateRun({ ...command, userMessageId })).runId;
  };
  return {
    alpha,
    alphaRuns,
    beta,
    busy,
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
    replace,
    /** Resolves once a regenerate or edit is at its provider call, where it stays until aborted. */
    replaced: replaced.promise,
    stopAlpha: (runId: string) =>
      expect(
        harness.core().stop({ commandId: randomUUID(), runId, threadId: alpha.threadId })
      ).resolves.toEqual({ outcome: 'stopped' }),
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

/** The parent's runs that delivered a follow-up's report, once `count` did and the last one ended. */
async function settledDeliveries(harness: ChildRunHarness, count: number) {
  let carrying: Awaited<ReturnType<typeof followUpDeliveries>> = [];
  await expect
    .poll(
      async () => {
        carrying = await followUpDeliveries(harness);
        const last = carrying.at(-1);
        return (
          carrying.length >= count &&
          last !== undefined &&
          (await harness.core().read(harness.threadId, 0)).some(finished(last.runId))
        );
      },
      { timeout: 5000 }
    )
    .toBe(true);
  return carrying;
}

/**
 * A later user turn delivers nothing from `childThreadId`: none of its results
 * is still owed to the parent. A wake for one would be admitted first (this
 * turn is then refused, the parent being busy) or deliver with this turn.
 */
async function expectNothingOwed(harness: ChildRunHarness, prompt: string, childThreadId: string) {
  const runId = await harness.start(prompt);
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 5000);
  const delivery = startedRuns(rows).find((run) => run.runId === runId)?.delivery;
  expect(delivery?.entries.filter((entry) => entry.childThreadId === childThreadId) ?? []).toEqual(
    []
  );
}

/**
 * A regenerate or edit of the input's message branches from the run that took
 * the input, but it is the person's new run, not that input's run: it reports
 * only when it completes, and it never holds the follow-up's report.
 */
test.each([
  ['a regenerate', 'regenerate'],
  ['an edit', 'edit'],
] as const)(
  "%s of a follow-up's input does not hold the follow-up's report, and stopping it wakes nothing",
  async (_, how) => {
    const child = await followUpTakingInput('held');
    const { busy, harness, lastRun, reads } = child;
    lastRun.release.resolve();
    // The parent is busy with its own turn, so the follow-up's report waits for that turn's end.
    const busyRun = await harness.start(BUSY);
    await busy.entered.promise;
    reads[0]?.release.resolve();
    await expect
      .poll(
        async () =>
          finishedRuns(await harness.core().read(child.alpha.threadId, 0)).map(
            ({ outcome }) => outcome
          ),
        { timeout: 5000 }
      )
      .toEqual(['completed', 'completed', 'completed']);
    const [followUp = '', inputRun = ''] = await child.alphaRuns();
    const replacement = await child.replace(how, inputRun, followUp);
    await child.replaced;
    busy.release.resolve();
    await rowsUntil(harness, harness.threadId, finished(busyRun), 5000);
    // The busy turn's end delivers the follow-up with its input's run, while the replacement runs.
    const [carrying, ...more] = await settledDeliveries(harness, 1);
    expect(more).toEqual([]);
    expect(reported(carrying?.delivery?.entries)).toEqual([
      { childRunId: followUp, followUp: true, state: 'returned' },
      { childRunId: inputRun, followUp: true, state: 'returned' },
    ]);
    // Stopped, the replacement is an ordinary follow-up that did not complete: it wakes nothing.
    await child.stopAlpha(replacement);
    await rowsUntil(harness, child.alpha.threadId, finished(replacement), 5000);
    await expectNothingOwed(harness, 'Again.', child.alpha.threadId);
    expect(await followUpDeliveries(harness)).toHaveLength(1);
  }
);

test.each([
  ['regenerate', 'the input'],
  ['edit', 'the input'],
  ['edit', 'the follow-up'],
] as const)('after a restart, an interrupted %s of %s reports nothing', async (how, message) => {
  const child = await followUpTakingInput('held');
  const { harness, lastRun, reads } = child;
  lastRun.release.resolve();
  reads[0]?.release.resolve();
  const [delivered] = await settledDeliveries(harness, 1);
  const [followUp = '', inputRun = ''] = await child.alphaRuns();
  expect(reported(delivered?.delivery?.entries)).toEqual([
    { childRunId: followUp, followUp: true, state: 'returned' },
    { childRunId: inputRun, followUp: true, state: 'returned' },
  ]);
  // Editing the follow-up's own message branches from Alpha's invocation, which took no input.
  const [replaced, parent] =
    message === 'the input' ? [inputRun, followUp] : [followUp, child.alpha.run?.runId ?? ''];
  await child.replace(how, replaced, parent);
  await child.replaced;
  await harness.core().close();
  // Restart: the replayed log names the input's original run, not its replacement.
  await harness.crash();
  expect(
    finishedRuns(await harness.core().read(child.alpha.threadId, 0)).map(({ outcome }) => outcome)
  ).toEqual(['completed', 'completed', 'completed', 'interrupted']);
  await expectNothingOwed(harness, 'Next.', child.alpha.threadId);
  expect(await followUpDeliveries(harness)).toHaveLength(1);
});

/**
 * The race an ordering rule gets wrong: a person's run/start naming the
 * follow-up as its parent is admitted between the follow-up's end and its
 * input's run/start, which is then refused while the person's run is active.
 * The input's run is the refusal, live and after a restart.
 */
test("after a restart, a run/start naming the follow-up ahead of its input's run/start does not take the input", async () => {
  const child = await followUpTakingInput('held');
  const { harness, reads } = child;
  const [followUp = ''] = await child.alphaRuns();
  // Beta's stop wake holds the admission queue until the follow-up's end is
  // committed; the person's run/start queues behind it, ahead of the input's.
  const ended = Promise.withResolvers<void>();
  const unsubscribe = harness.core().onCommitted((row) => {
    if (finished(followUp)(row)) {
      ended.resolve();
    }
  });
  cleanup.push(async () => unsubscribe());
  const admitted = child.holdNextWake(ended.promise);
  await child.stopBeta();
  await admitted;
  const edited = child.replace('edit', '', followUp);
  reads[0]?.release.resolve();
  const person = await edited;
  await child.replaced;
  const alphaRows = async () => harness.core().read(child.alpha.threadId, 0);
  await expect
    .poll(async () => finishedRuns(await alphaRows()).map(({ outcome }) => outcome), {
      timeout: 5000,
    })
    .toEqual(['completed', 'completed', 'failed']);
  const refused = startedRuns(await alphaRows()).find(({ prompt }) => prompt === INPUT)?.runId;
  // Live, the refusal is the input's run: it reports with the follow-up.
  const [delivered, ...more] = await settledDeliveries(harness, 1);
  expect(more).toEqual([]);
  expect(reported(delivered?.delivery?.entries)).toEqual([
    { childRunId: followUp, followUp: true, state: 'returned' },
    { childRunId: refused, followUp: true, state: 'failed' },
  ]);
  await harness.core().close();
  await harness.crash();
  expect(finishedRuns(await alphaRows()).find(({ runId }) => runId === person)?.outcome).toBe(
    'interrupted'
  );
  // Replayed, the person's interrupted run is an ordinary follow-up: it reports nothing.
  await expectNothingOwed(harness, 'Next.', child.alpha.threadId);
  expect(await followUpDeliveries(harness)).toHaveLength(1);
});
