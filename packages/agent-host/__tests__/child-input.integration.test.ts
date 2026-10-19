/**
 * BST-1932 (AT-09, approved Option C): human input typed into a RUNNING child.
 * The host ends the child's active run after its step in flight and starts the
 * input as the child's next run, through the ordinary run admission. Only that
 * run's end reports to the parent, in one wake. A root thread queues its next
 * message instead, and a settled child takes a follow-up run/start.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { committedRunIdentity } from '../src/committed-identities.js';
import type { HostChildDeliveryEntry, HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  childThreads,
  explorer,
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
import {
  captureHostFailureDiagnostics,
  INTERNAL_FAULT_DETAIL,
} from './fixtures/host-failure-diagnostics.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'INPUT_TASK: read the notes.';
const INPUT = 'HUMAN_INPUT_7: check the date too.';
const LEDGER = 'Background invocations of this turn';
const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const finishedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event] : []));

function inputModel() {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (toolNames(call).includes('agent-explore')) {
        if (user.includes(LEDGER)) {
          return stream(text('Parent read the child.'));
        }
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent continues.'))
          : stream(toolCall('agent-explore', { prompt: TASK }, 'input-1'));
      }
      if (user.includes(INPUT)) {
        return stream(text('Child read the input.'));
      }
      return call.prompt.some((message) => message.role === 'tool')
        ? stream(text('Child missed the input.'))
        : stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
    },
  });
}

test('a running child ends after its step in flight, and the input runs next and reports once', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const [active] = startedRuns(await harness.core().read(childThreadId, 0));
  try {
    await expect(
      harness.core().input({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: INPUT,
        runId: active?.runId ?? '',
        threadId: childThreadId,
      })
    ).resolves.toEqual({ accepted: true });
  } finally {
    release.resolve();
  }

  // The input's run follows the active run, which ended after its tool result.
  const child = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== active?.runId,
    5000
  );
  const runs = startedRuns(child);
  expect(runs).toHaveLength(2);
  expect(finishedRuns(child).map(({ outcome }) => outcome)).toEqual(['completed', 'completed']);
  const childCalls = model.doStreamCalls.filter(
    (call) => !toolNames(call).includes('agent-explore')
  );
  expect(childCalls).toHaveLength(2);
  const answered = childCalls[1] as CallOptions;
  expect(answered.prompt.map((message) => message.role).slice(-3)).toEqual([
    'assistant',
    'tool',
    'user',
  ]);
  expect(userTexts(answered).at(-1)).toBe(INPUT);

  // One wake, after the input's run: the parent reads the answer the input produced.
  const parent = await rowsUntil(
    harness,
    harness.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== rootRunId,
    5000
  );
  const wakes = startedRuns(parent).filter(({ delivery }) => delivery?.via === 'wake');
  expect(wakes).toHaveLength(1);
  expect(JSON.stringify(wakes[0]?.delivery)).toContain('Child read the input.');
});

/**
 * A sibling's wake can be admitted while the child's input is still to run:
 * before its run starts (the wake holds the admission queue that run waits
 * on), or while it runs. Either way the steered child is still at work.
 */
test.each(['before the input run starts', 'while the input run runs'] as const)(
  "a sibling's wake %s leaves the child to report with its input's run",
  async (moment) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inputEntered = Promise.withResolvers<void>();
    const inputHeld = Promise.withResolvers<void>();
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
        if (users[0] === 'BETA') {
          return blocked(call);
        }
        if (users.at(-1) === INPUT) {
          inputEntered.resolve();
          if (moment === 'while the input run runs') {
            await inputHeld.promise;
          }
          return stream(text('Child read the input.'));
        }
        return stream(toolCall('read_file', { path: 'notes.md' }, 'read-alpha'));
      },
    });
    // Before: the sibling's first wake is admitted only once the steered run's
    // end is folded, so it sits between that end and the input run's start.
    const wakeEntered = Promise.withResolvers<void>();
    const steeredEnded = Promise.withResolvers<void>();
    let wakes = 0;
    const harness = await setupChildRunHost(
      model,
      cleanup,
      {
        readFile: async () => {
          entered.resolve();
          await release.promise;
          return { content: 'notes' };
        },
      },
      (platform) => {
        const admit = recordingAdmission([])(platform);
        if (!admit) {
          throw new Error('The recording admission must admit runs');
        }
        return async (request) => {
          const wake = request.prompt === undefined;
          if (moment === 'before the input run starts' && wake && wakes++ === 0) {
            wakeEntered.resolve();
            await steeredEnded.promise;
          }
          return admit(request);
        };
      }
    );
    const rootRunId = await harness.start('Delegate.');
    await entered.promise;
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
    const steered = alpha.run.runId;
    const unsubscribe = harness.core().onCommitted((row) => {
      if (row.event.type === 'run.finished' && row.event.runId === steered) {
        steeredEnded.resolve();
      }
    });
    const betaRunId = beta.run.runId;
    const stopBeta = () =>
      expect(
        harness.core().stop({ commandId: randomUUID(), runId: betaRunId, threadId: beta.threadId })
      ).resolves.toEqual({ outcome: 'stopped' });
    const wakeRuns = async () =>
      startedRuns(await harness.core().read(harness.threadId, 0)).filter(
        ({ delivery }) => delivery?.via === 'wake'
      );
    try {
      await expect(
        harness.core().input({
          commandId: randomUUID(),
          modelId: 'scripted',
          prompt: INPUT,
          runId: steered,
          threadId: alpha.threadId,
        })
      ).resolves.toEqual({ accepted: true });
      if (moment === 'before the input run starts') {
        await stopBeta();
        await wakeEntered.promise;
        release.resolve();
      } else {
        release.resolve();
        await inputEntered.promise;
        await stopBeta();
        await expect.poll(wakeRuns, { timeout: 5000 }).toHaveLength(1);
        inputHeld.resolve();
      }
    } finally {
      release.resolve();
      inputHeld.resolve();
    }

    const child = await rowsUntil(
      harness,
      alpha.threadId,
      (row) => row.event.type === 'run.finished' && row.event.runId !== steered,
      5000
    );
    unsubscribe();
    const alphaRuns = startedRuns(child).map(({ runId }) => runId);
    expect(finishedRuns(child).map(({ outcome }) => outcome)).toEqual(['completed', 'completed']);
    const alphaEntries = (rows: readonly HostLogRow[]) =>
      startedRuns(rows).flatMap(({ delivery }) =>
        (delivery?.entries ?? []).filter(({ childThreadId }) => childThreadId === alpha.threadId)
      );
    await expect
      .poll(async () => alphaEntries(await harness.core().read(harness.threadId, 0)), {
        timeout: 5000,
      })
      .toHaveLength(2);
    const parent = await wakeRuns();
    // Beta's wake told the parent Alpha was still at work: it was, on the human's input.
    expect(parent[0]?.delivery?.entries.map(({ childThreadId }) => childThreadId)).toEqual([
      beta.threadId,
    ]);
    expect(parent[0]?.prompt).toContain('- alpha (agent-explore, Explorer): still running.');
    expect(parent[0]?.prompt).not.toContain('Nothing is still running');
    // One later wake carries both of Alpha's runs.
    const carrying = parent.filter(({ delivery }) =>
      delivery?.entries.some(({ childThreadId }) => childThreadId === alpha.threadId)
    );
    expect(carrying).toHaveLength(1);
    expect(
      carrying[0]?.delivery?.entries
        .filter(({ childThreadId }) => childThreadId === alpha.threadId)
        .map(({ childRunId }) => childRunId)
    ).toEqual(alphaRuns);
    expect(JSON.stringify(carrying[0]?.delivery)).toContain('Child read the input.');
  }
);

const EDITED = 'HUMAN_INPUT_9: check the year instead.';

/**
 * A child whose input's run fails at its provider, or stays open until it is
 * aborted; or completes, while a regenerate of it, or an edit, stays open.
 */
function endingInputModel(input: 'fails' | 'fails-once' | 'blocks' | 'replacement-blocks') {
  const entered = Promise.withResolvers<void>();
  let inputCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (toolNames(call).includes('agent-explore')) {
        if (user.includes(LEDGER)) {
          return stream(text('Parent read the child.'));
        }
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent continues.'))
          : stream(toolCall('agent-explore', { prompt: TASK }, 'input-1'));
      }
      if (user.includes(EDITED)) {
        return blocked(call);
      }
      if (user.includes(INPUT)) {
        entered.resolve();
        inputCalls += 1;
        if (input === 'replacement-blocks') {
          return inputCalls === 1 ? stream(text('Child read the input.')) : blocked(call);
        }
        if (input === 'blocks') {
          return blocked(call);
        }
        if (input === 'fails' || inputCalls === 1) {
          throw new Error('The provider refused the input.');
        }
        return stream(text('Child read the input.'));
      }
      return stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
    },
  });
  return { inputEntered: entered.promise, model };
}

/** A background child held in its first tool call, after its parent's turn ended, that took input. */
async function steeredChild(model: MockLanguageModelV4) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  cleanup.push(async () => release.resolve());
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const steered = startedRuns(await harness.core().read(childThreadId, 0))[0]?.runId ?? '';
  await expect(
    harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId: steered,
      threadId: childThreadId,
    })
  ).resolves.toEqual({ accepted: true });
  /** The child's two runs once both ended: the steered run and the run that took its input. */
  const childRuns = async () => {
    const rows = await rowsUntil(
      harness,
      childThreadId,
      (row) => row.event.type === 'run.finished' && row.event.runId !== steered,
      5000
    );
    return {
      ids: startedRuns(rows).map(({ runId }) => runId),
      outcomes: finishedRuns(rows).map(({ outcome }) => outcome),
    };
  };
  /** The parent's runs that delivered the child's results, once `count` did and the last ended. */
  const deliveries = async (count: number) => {
    let carrying: ReturnType<typeof startedRuns> = [];
    await expect
      .poll(
        async () => {
          const rows = await harness.core().read(harness.threadId, 0);
          carrying = startedRuns(rows).filter(({ delivery }) =>
            delivery?.entries.some((entry) => entry.childThreadId === childThreadId)
          );
          const last = carrying.at(-1);
          return carrying.length >= count && last !== undefined && rows.some(finished(last.runId));
        },
        { timeout: 5000 }
      )
      .toBe(true);
    return carrying;
  };
  /** A later user turn delivers nothing again. */
  const expectNoRedelivery = async () => {
    const again = await harness.start('Again.');
    const rows = await rowsUntil(harness, harness.threadId, finished(again), 5000);
    expect(startedRuns(rows).find(({ runId }) => runId === again)?.delivery).toBeUndefined();
  };
  return {
    childRuns,
    childThreadId,
    deliveries,
    expectNoRedelivery,
    harness,
    release: release.resolve,
    rootRunId,
    steered,
  };
}

const reported = (entries: readonly HostChildDeliveryEntry[] | undefined) =>
  entries?.map(({ childRunId, followUp, state }) => ({ childRunId, followUp, state }));

test("the input's run failing wakes the parent once, with the run whose input it took", async () => {
  const { inputEntered, model } = endingInputModel('fails');
  const { childRuns, deliveries, expectNoRedelivery, release } = await steeredChild(model);
  release();
  await inputEntered;
  const { ids, outcomes } = await childRuns();
  expect(outcomes).toEqual(['completed', 'failed']);
  const [wake, ...more] = await deliveries(1);
  expect(more).toEqual([]);
  expect(wake?.delivery?.via).toBe('wake');
  expect(reported(wake?.delivery?.entries)).toEqual([
    { childRunId: ids[0], followUp: undefined, state: 'returned' },
    { childRunId: ids[1], followUp: true, state: 'failed' },
  ]);
  expect(wake?.prompt).toContain('"status":"failed"');
  await expectNoRedelivery();
});

test("stopping the input's run wakes the parent once, with the run whose input it took", async () => {
  const { inputEntered, model } = endingInputModel('blocks');
  const { childThreadId, childRuns, deliveries, expectNoRedelivery, harness, release, steered } =
    await steeredChild(model);
  release();
  await inputEntered;
  const inputRun = startedRuns(await harness.core().read(childThreadId, 0)).find(
    ({ runId }) => runId !== steered
  );
  await expect(
    harness
      .core()
      .stop({ commandId: randomUUID(), runId: inputRun?.runId ?? '', threadId: childThreadId })
  ).resolves.toEqual({ outcome: 'stopped' });
  const { ids, outcomes } = await childRuns();
  expect(outcomes).toEqual(['completed', 'stopped']);
  const [wake, ...more] = await deliveries(1);
  expect(more).toEqual([]);
  expect(wake?.delivery?.via).toBe('wake');
  expect(reported(wake?.delivery?.entries)).toEqual([
    { childRunId: ids[0], followUp: undefined, state: 'returned' },
    { childRunId: ids[1], followUp: true, state: 'cancelled' },
  ]);
  await expectNoRedelivery();
});

// A retry is the person's own run, not the input's run (BST-2178): completed, it reports alone.
test("a retry of the failed input's run, after both runs were delivered, reports on its own", async () => {
  const { inputEntered, model } = endingInputModel('fails-once');
  const { childThreadId, childRuns, deliveries, harness, release } = await steeredChild(model);
  release();
  await inputEntered;
  const { ids } = await childRuns();
  await deliveries(1);
  const failedInput = ids[1] ?? '';
  const { userMessageId } = committedRunIdentity(
    await harness.core().read(childThreadId, 0),
    failedInput
  );
  const { runId: retried } = await harness.core().regenerateRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId: childThreadId,
    userMessageId,
  });
  await rowsUntil(harness, childThreadId, finished(retried), 5000);
  const [, retry, ...more] = await deliveries(2);
  expect(more).toEqual([]);
  expect(retry?.delivery?.via).toBe('wake');
  expect(reported(retry?.delivery?.entries)).toEqual([
    { childRunId: retried, followUp: true, state: 'returned' },
  ]);
  expect(JSON.stringify(retry?.delivery)).toContain('Child read the input.');
});

/**
 * BST-2178: a regenerate or edit of the input's message branches from the
 * invocation, but it is the person's new run, not the input's run: stopped, it
 * reports nothing.
 */
test.each(['regenerate', 'edit'] as const)(
  "a stopped %s of the input's message, after both runs were delivered, wakes nothing",
  async (how) => {
    const { model } = endingInputModel('replacement-blocks');
    const { childThreadId, childRuns, deliveries, expectNoRedelivery, harness, release, steered } =
      await steeredChild(model);
    release();
    const { ids, outcomes } = await childRuns();
    expect(outcomes).toEqual(['completed', 'completed']);
    await deliveries(1);
    const command = { commandId: randomUUID(), modelId: 'scripted', threadId: childThreadId };
    const { runId: replacement } =
      how === 'edit'
        ? await harness.core().startRun({ ...command, parentMessageId: steered, prompt: EDITED })
        : await harness.core().regenerateRun({
            ...command,
            userMessageId: committedRunIdentity(
              await harness.core().read(childThreadId, 0),
              ids[1] ?? ''
            ).userMessageId,
          });
    await expect(
      harness.core().stop({ commandId: randomUUID(), runId: replacement, threadId: childThreadId })
    ).resolves.toEqual({ outcome: 'stopped' });
    await rowsUntil(harness, childThreadId, finished(replacement), 5000);
    // A wake for the stopped replacement would be admitted first (this turn is
    // then refused, the parent being busy) or deliver it with this turn.
    await expectNoRedelivery();
    expect(await deliveries(1)).toHaveLength(1);
  }
);

test("a host closed while the input's run runs delivers both runs once, at the next user turn after restart", async () => {
  const { inputEntered, model } = endingInputModel('blocks');
  const { childRuns, deliveries, expectNoRedelivery, harness, release } = await steeredChild(model);
  release();
  await inputEntered;
  await harness.core().close();
  // Restart: the steered flag folds from the committed run/input; the input's run is terminal.
  await harness.crash();
  const { ids, outcomes } = await childRuns();
  expect(outcomes).toEqual(['completed', 'interrupted']);
  const next = await harness.start('Next.');
  const [turn, ...more] = await deliveries(1);
  expect(more).toEqual([]);
  expect(turn?.runId).toBe(next);
  expect(turn?.delivery?.via).toBe('next-turn');
  expect(reported(turn?.delivery?.entries)).toEqual([
    { childRunId: ids[0], followUp: undefined, state: 'returned' },
    { childRunId: ids[1], followUp: true, state: 'failed' },
  ]);
  await expectNoRedelivery();
});

test('a root Stop of a turn whose child took input wakes nothing; the next user turn delivers both runs once', async () => {
  const { model } = endingInputModel('fails');
  const { childRuns, deliveries, expectNoRedelivery, harness, release, rootRunId } =
    await steeredChild(model);
  const stopping = harness
    .core()
    .stop({ commandId: randomUUID(), runId: rootRunId, threadId: harness.threadId });
  release();
  await expect(stopping).resolves.toEqual({ outcome: 'already-terminal' });
  // The stopped child refused its input: that refusal is committed as the input's failed run.
  const { ids, outcomes } = await childRuns();
  expect(outcomes).toEqual(['stopped', 'failed']);
  const next = await harness.start('Why did it stop?');
  const [turn, ...more] = await deliveries(1);
  expect(more).toEqual([]);
  expect(turn?.runId).toBe(next);
  expect(turn?.delivery?.via).toBe('next-turn');
  expect(reported(turn?.delivery?.entries)).toEqual([
    { childRunId: ids[0], followUp: undefined, state: 'cancelled' },
    { childRunId: ids[1], followUp: true, state: 'failed' },
  ]);
  await expectNoRedelivery();
});

const FOLLOW_UP = 'FOLLOW_UP_3: which file next?';

/**
 * A legacy run/steer, unlike run/input, hands nothing to the child's next run:
 * a follow-up typed into the steered child after it ended is its own run. The
 * parent's own turn stays open (until released, or until aborted) so the
 * steered child's report waits for the parent, not for a wake.
 */
async function steerWithoutInput(parentTurn: 'released' | 'until-aborted') {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const parentHeld = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const users = userTexts(call);
      if (toolNames(call).includes('agent-explore')) {
        if (users.join('\n').includes(LEDGER)) {
          return stream(text('Parent read the child.'));
        }
        if (!call.prompt.some((message) => message.role === 'tool')) {
          return stream(toolCall('agent-explore', { prompt: TASK }, 'steer-1'));
        }
        if (users.at(-1) !== 'Delegate.') {
          return stream(text('Parent continues.'));
        }
        if (parentTurn === 'until-aborted') {
          return blocked(call);
        }
        await parentHeld.promise;
        return stream(text('Parent continues.'));
      }
      if (users.at(-1) === FOLLOW_UP) {
        // The follow-up parks on a question to the person.
        return stream(toolCall('ask_user', { question: 'Which file?' }, 'ask-1'));
      }
      return stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [{ ...explorer, allowedToolIds: ['read_file', 'ask_user'] }],
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  cleanup.push(async () => {
    release.resolve();
    parentHeld.resolve();
  });
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  const [childThreadId = ''] = await childThreads(harness);
  const steered = startedRuns(await harness.core().read(childThreadId, 0))[0]?.runId ?? '';
  await expect(
    harness.core().steer({ commandId: randomUUID(), runId: steered, threadId: childThreadId })
  ).resolves.toEqual({ outcome: 'steering' });
  release.resolve();
  const ended = await rowsUntil(harness, childThreadId, finished(steered), 5000);
  expect(ended.find(finished(steered))?.event).toMatchObject({ outcome: 'completed' });
  // The parent's turn is still open, so the steered child's report has not been delivered.
  expect((await harness.core().read(harness.threadId, 0)).some(finished(rootRunId))).toBe(false);
  /**
   * A follow-up branched from the steered run, parked on its question: typed
   * at the tip, or naming the steered run as its parent, as an edit does.
   */
  const parkFollowUp = async (named = false) => {
    const { runId } = await harness.core().startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      ...(named ? { parentMessageId: steered } : {}),
      prompt: FOLLOW_UP,
      threadId: childThreadId,
    });
    const rows = await rowsUntil(
      harness,
      childThreadId,
      (row) => row.event.type === 'interaction.requested',
      5000
    );
    expect(startedRuns(rows).find((run) => run.runId === runId)?.parentMessageId).toBe(steered);
    return runId;
  };
  return { childThreadId, harness, parkFollowUp, releaseParent: parentHeld.resolve, steered };
}

test("a follow-up after a run/steer does not hold the steered child's report", async () => {
  const { childThreadId, harness, parkFollowUp, releaseParent, steered } =
    await steerWithoutInput('released');
  const followUp = await parkFollowUp();
  releaseParent();
  // The parent's turn ends and wakes it with the steered child's report.
  await expect
    .poll(
      async () =>
        startedRuns(await harness.core().read(harness.threadId, 0))
          .filter(({ delivery }) => delivery?.via === 'wake')
          .map(({ delivery }) => reported(delivery?.entries)),
      { timeout: 5000 }
    )
    .toEqual([[{ childRunId: steered, followUp: undefined, state: 'returned' }]]);
  // The follow-up is still waiting on its question: the report did not wait for it.
  expect((await harness.core().read(childThreadId, 0)).some(finished(followUp))).toBe(false);
});

test('after a restart, a replayed run/steer does not hold the report while a follow-up waits', async () => {
  const { harness, parkFollowUp, steered } = await steerWithoutInput('until-aborted');
  await harness.core().close();
  await harness.crash();
  await parkFollowUp();
  const next = await harness.start('Next.');
  const rows = await rowsUntil(harness, harness.threadId, finished(next), 5000);
  const turn = startedRuns(rows).find(({ runId }) => runId === next);
  expect(turn?.delivery?.via).toBe('next-turn');
  expect(reported(turn?.delivery?.entries)).toEqual([
    { childRunId: steered, followUp: undefined, state: 'returned' },
  ]);
});

test('after a restart, a follow-up naming a run/steer-ended child as its parent is not reported with it', async () => {
  const { harness, parkFollowUp, steered } = await steerWithoutInput('until-aborted');
  // Replayed, the follow-up's run/start names the steered run; a run/steer handed it no input.
  await parkFollowUp(true);
  await harness.core().close();
  await harness.crash();
  const next = await harness.start('Next.');
  const rows = await rowsUntil(harness, harness.threadId, finished(next), 5000);
  const turn = startedRuns(rows).find(({ runId }) => runId === next);
  expect(turn?.delivery?.via).toBe('next-turn');
  expect(reported(turn?.delivery?.entries)).toEqual([
    { childRunId: steered, followUp: undefined, state: 'returned' },
  ]);
});

/** BST-2178: an inline child returned its result to its tool call, so it never reports. */
test("an inline child's input run, once completed, reports on its own as a follow-up", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const user = userTexts(call).join('\n');
      if (toolNames(call).includes('agent-explore')) {
        if (user.includes('child_continuation_result')) {
          return stream(text('Parent read the child.'));
        }
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent continues.'))
          : stream(
              toolCall(
                'agent-explore',
                { _background: { disposition: 'foreground' }, prompt: TASK },
                'inline-1'
              )
            );
      }
      return user.includes(INPUT)
        ? stream(text('Child read the input.'))
        : stream(toolCall('read_file', { path: 'notes.md' }, 'read-1'));
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  cleanup.push(async () => release.resolve());
  await harness.start('Delegate.');
  await entered.promise;
  const [childThreadId = ''] = await childThreads(harness);
  const invocation = startedRuns(await harness.core().read(childThreadId, 0))[0]?.runId ?? '';
  await expect(
    harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId: invocation,
      threadId: childThreadId,
    })
  ).resolves.toEqual({ accepted: true });
  release.resolve();
  const child = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== invocation,
    5000
  );
  const inputRun = startedRuns(child).at(-1)?.runId;
  const carrying = async () =>
    startedRuns(await harness.core().read(harness.threadId, 0)).filter(({ delivery }) =>
      delivery?.entries.some((entry) => entry.childThreadId === childThreadId)
    );
  await expect.poll(async () => (await carrying()).length, { timeout: 5000 }).toBe(1);
  const [delivered] = await carrying();
  expect(reported(delivered?.delivery?.entries)).toEqual([
    { childRunId: inputRun, followUp: true, state: 'returned' },
  ]);
});

test('only a running child accepts human input', async () => {
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup);
  const rootRunId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const input = (threadId: string, runId: string) =>
    harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId,
      threadId,
    });
  await expect(input(harness.threadId, rootRunId)).rejects.toThrow(
    'Human input reaches a running child'
  );
  const [childThreadId = ''] = await childThreads(harness);
  const [childRun] = startedRuns(await harness.core().read(childThreadId, 0));
  await rowsUntil(harness, childThreadId, finished(childRun?.runId ?? ''), 5000);
  await expect(input(childThreadId, childRun?.runId ?? '')).rejects.toThrow(
    'The child is not running'
  );
});

test('input a stopped child never read commits a safe failed run and retains its diagnostic cause', async () => {
  const diagnostics = captureHostFailureDiagnostics();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = inputModel();
  const harness = await setupChildRunHost(model, cleanup, {
    readFile: async () => {
      entered.resolve();
      await release.promise;
      return { content: 'notes' };
    },
  });
  const rootRunId = await harness.start('Delegate.');
  await entered.promise;
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 5000);
  const [childThreadId = ''] = await childThreads(harness);
  const [active] = startedRuns(await harness.core().read(childThreadId, 0));
  const runId = active?.runId ?? '';
  try {
    await harness.core().input({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: INPUT,
      runId,
      threadId: childThreadId,
    });
    const stopped = harness
      .core()
      .stop({ commandId: randomUUID(), runId, threadId: childThreadId });
    release.resolve();
    await stopped;
  } finally {
    release.resolve();
  }
  const child = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished' && row.event.runId !== runId,
    5000
  );
  expect(finishedRuns(child).map(({ detail, outcome }) => ({ detail, outcome }))).toEqual([
    { detail: undefined, outcome: 'stopped' },
    { detail: INTERNAL_FAULT_DETAIL, outcome: 'failed' },
  ]);
  diagnostics.expectCause('The child run ended stopped before it read this input.');
  // The input never reached the model.
  expect(model.doStreamCalls.filter((call) => userTexts(call).join('\n').includes(INPUT))).toEqual(
    []
  );
});
