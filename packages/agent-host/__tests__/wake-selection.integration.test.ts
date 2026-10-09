/**
 * ADR-0019: a thread's run selection is a host fact. A composer pick commits
 * it, a run command whose pair differs commits it, and a wake admits fresh
 * from it, including after a host restart.
 */
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostRunAdmissionRequest } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  type ChildRunHarness,
  childThreads,
  finished,
  recordingAdmission,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCalls,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LEDGER = 'Background invocations of this turn';
const PICKED = { configuration: { effort: 'max' }, modelId: 'picked-model' };

const selections = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'thread.selection.updated' ? [event] : []));
const wakes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) =>
    event.type === 'run.started' && event.delivery?.via === 'wake' ? [event] : []
  );

/** The parent fans out to two background children and holds its next step until released. */
function fanOutModel() {
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const names = (call.tools ?? []).map((tool) => tool.name);
      const user = userTexts(call).at(-1) ?? '';
      if (!names.includes('agent-explore')) {
        return stream(text('Child outcome.'));
      }
      if (user.includes(LEDGER)) {
        return stream(text('Parent used the delivered outcomes.'));
      }
      if (call.prompt.some((message) => message.role === 'tool')) {
        await release.promise;
        return stream(text('Parent continues while workers run.'));
      }
      return stream(
        toolCalls([
          ['agent-explore', { prompt: 'ALPHA_TASK: survey alpha.' }, 'fan-1'],
          ['agent-explore', { prompt: 'BETA_TASK: survey beta.' }, 'fan-2'],
        ])
      );
    },
  });
  return { model, release: release.resolve };
}

async function settledChildren(harness: ChildRunHarness): Promise<void> {
  await expect
    .poll(async () => {
      const threads = await childThreads(harness);
      const settled = await Promise.all(
        threads.map(async (threadId) =>
          (await harness.core().read(threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
      );
      return threads.length === 2 && settled.every(Boolean);
    })
    .toBe(true);
}

async function settledWake(harness: ChildRunHarness): Promise<HostLogRow[]> {
  const rows = await rowsUntil(harness, harness.threadId, (row) => wakes([row]).length > 0);
  return rowsUntil(harness, harness.threadId, finished(wakes(rows)[0]?.runId ?? ''));
}

test('a pick committed while the children run is the selection the wake admits', async () => {
  const { model, release } = fanOutModel();
  const requests: HostRunAdmissionRequest[] = [];
  const harness = await setupChildRunHost(model, cleanup, {}, recordingAdmission(requests));
  await harness.start('Fan out.');
  await settledChildren(harness);
  const { threadId } = harness;
  const pick = { ...PICKED, commandId: randomUUID(), threadId };
  await expect(harness.core().selections.set(pick)).resolves.toEqual({ accepted: true });
  // A repeated pick commits its command once and changes nothing.
  await harness.core().selections.set({ ...pick, commandId: randomUUID() });
  expect(harness.core().selections.read(threadId)).toEqual({ selection: PICKED });
  release();
  const rows = await settledWake(harness);

  expect(selections(rows)).toEqual([
    { modelId: 'scripted', type: 'thread.selection.updated' },
    { ...PICKED, type: 'thread.selection.updated' },
  ]);
  expect(wakes(rows)[0]).toMatchObject({ modelId: 'picked-model' });
  expect(requests.at(-1)).toMatchObject(PICKED);
  expect(requests.at(-1)?.snapshot).toBeUndefined();
  // A delegated child starts on its parent run's selection.
  for (const child of await childThreads(harness)) {
    expect(harness.core().selections.read(child)).toEqual({
      selection: { modelId: 'scripted' },
    });
  }
});

test('a wake after a host restart admits from the selection committed before it', async () => {
  const { model, release } = fanOutModel();
  release();
  const requests: HostRunAdmissionRequest[] = [];
  const harness = await setupChildRunHost(model, cleanup, {}, recordingAdmission(requests));
  const { threadId } = harness;
  await harness.core().selections.set({ ...PICKED, commandId: randomUUID(), threadId });
  await harness.crash();
  expect(harness.core().selections.read(threadId)).toEqual({ selection: PICKED });

  // The restarted host folded the pick: a run with the same pair commits no new selection.
  const { runId } = await harness
    .core()
    .startRun({ ...PICKED, commandId: randomUUID(), prompt: 'Fan out.', threadId });
  const rows = await settledWake(harness);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
  expect(selections(rows)).toEqual([{ ...PICKED, type: 'thread.selection.updated' }]);
  expect(wakes(rows)[0]).toMatchObject({ modelId: 'picked-model' });
  expect(requests.at(-1)).toMatchObject(PICKED);
});

test('a run whose pair differs from the selection commits it before its run.started', async () => {
  const { model, release } = fanOutModel();
  release();
  const harness = await setupChildRunHost(model, cleanup);
  const { threadId } = harness;
  await harness.core().selections.set({ ...PICKED, commandId: randomUUID(), threadId });
  const runId = await harness.start('Fan out.');
  const rows = await rowsUntil(harness, threadId, finished(runId));
  const types = rows.map(({ event }) => event.type);
  expect(types.lastIndexOf('thread.selection.updated')).toBe(types.indexOf('run.started') - 1);
  expect(selections(rows).at(-1)).toEqual({
    modelId: 'scripted',
    type: 'thread.selection.updated',
  });
  expect(harness.core().selections.read(threadId)).toEqual({
    selection: { modelId: 'scripted' },
  });
  expect(() => harness.core().selections.read('unknown-thread')).toThrow('Unknown thread');
});
