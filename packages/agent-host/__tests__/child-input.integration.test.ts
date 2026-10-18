/**
 * BST-1932 (AT-09, approved Option C): human input typed into a RUNNING child.
 * The host ends the child's active run after its step in flight and starts the
 * input as the child's next run, through the ordinary run admission. Only that
 * run's end reports to the parent, in one wake. A root thread queues its next
 * message instead, and a settled child takes a follow-up run/start.
 */
import { randomUUID } from 'node:crypto';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { committedRunIdentity } from '../src/committed-identities.js';
import type { HostChildDeliveryEntry, HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
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
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';

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

/** A child whose input's run fails at its provider, or stays open until it is aborted. */
function endingInputModel(input: 'fails' | 'fails-once' | 'blocks') {
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
      if (user.includes(INPUT)) {
        entered.resolve();
        inputCalls += 1;
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

test("a retried input's run reports on its own once the run whose input it took was delivered", async () => {
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
    { detail: INTERNAL_FAULT.message, outcome: 'failed' },
  ]);
  diagnostics.expectCause('The child run ended stopped before it read this input.');
  // The input never reached the model.
  expect(model.doStreamCalls.filter((call) => userTexts(call).join('\n').includes(INPUT))).toEqual(
    []
  );
});
