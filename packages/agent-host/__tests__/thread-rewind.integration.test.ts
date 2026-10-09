/**
 * Restore to before a message through Core (gap 2): a real HostCore and
 * StateStore. A rewind commits its intent and outcome to the thread's log,
 * the next message branches from the rewound tip, and a rewind the host
 * stopped inside is committed as interrupted when the host next opens.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRewindFiles } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const ROOT = { rootId: 'root-1', rootPath: '/workspace/project' };
const oid = (digit: string) => digit.repeat(40);

function platform(rewindFiles: HostRewindFiles): HostPlatform {
  let turn = 0;
  return {
    admitRun: async () => ({
      // Each run's turn start is its own snapshot of the one root.
      captureTurnBoundary: async (request) => [
        { ...ROOT, commitOid: oid(request.boundary === 'turn-start' ? String(++turn) : 'e') },
      ],
      configuration: {},
      model: scriptedModel(),
      snapshot: { configuration: {}, maxSteps: 2, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    rewindFiles,
  };
}

async function openCore(root: string, rewindFiles: HostRewindFiles) {
  const store = await StateStore.open(root);
  const core = await HostCore.open(store, platform(rewindFiles), () => () => undefined);
  return { core, store };
}

async function finishedRun(core: HostCore, threadId: string, prompt: string) {
  const commandId = randomUUID();
  const { runId } = await core.startRun({ commandId, modelId: 'scripted', prompt, threadId });
  await expect
    .poll(async () =>
      (await core.read(threadId, 0)).some(
        ({ event }) => event.type === 'run.finished' && event.runId === runId
      )
    )
    .toBe(true);
  return { messageId: commandId, runId };
}

const types = (rows: readonly { readonly event: HostEvent }[]) =>
  rows.map(({ event }) => event.type).filter((type) => type.startsWith('thread.rew'));

test('a rewind restores files to the message’s turn start, and the next message branches from before it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-rewind-core-'));
  const applied: unknown[] = [];
  const files: HostRewindFiles = {
    apply: async (request) => {
      applied.push(request.targets);
      return [{ path: 'notes.txt', rootId: ROOT.rootId, status: 'restored' }];
    },
    drift: async () => [],
    preview: async () => ({ previewId: 'preview-1' }),
    redo: async () => [],
    redoConflicts: async () => [],
  };
  const { core, store } = await openCore(root, files);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const first = await finishedRun(core, threadId, 'First');
  const second = await finishedRun(core, threadId, 'Second');

  const preview = await core.previewRewind({ messageId: second.messageId, threadId });
  expect(preview.files).toEqual({
    available: true,
    fromRunId: second.runId,
    previewId: 'preview-1',
    roots: [{ ...ROOT, commitOid: oid('2') }],
  });
  const rewound = await core.rewind({
    commandId: randomUUID(),
    messageId: second.messageId,
    mode: 'conversation-and-files',
    previewId: 'preview-1',
    threadId,
  });
  expect(rewound).toMatchObject({ status: 'rewound' });
  expect(applied).toEqual([[{ ...ROOT, commitOid: oid('2') }]]);
  expect(types(await core.read(threadId, 0))).toEqual(['thread.rewind.started', 'thread.rewound']);

  // The next message names no parent, so it follows the run before the rewound message.
  const third = await finishedRun(core, threadId, 'Third');
  const started = (await core.read(threadId, 0)).flatMap(({ event }) =>
    event.type === 'run.started' && event.runId === third.runId ? [event] : []
  );
  expect(started).toMatchObject([{ parentMessageId: first.runId }]);
});

test('a rewind the host stopped inside is committed as interrupted when the host next opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-rewind-core-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const restore = Promise.withResolvers<never>();
  restore.promise.catch(() => undefined);
  const files: HostRewindFiles = {
    // The restore never settles: the host closes with the rewind started.
    apply: () => restore.promise,
    drift: async () => [],
    preview: async () => ({ previewId: 'preview-1' }),
    redo: async () => [],
    redoConflicts: async () => [],
  };
  const opened = await openCore(root, files);
  const { threadId } = await opened.core.startThread({ commandId: randomUUID() });
  const { messageId } = await finishedRun(opened.core, threadId, 'First');
  await opened.core.previewRewind({ messageId, threadId });
  void opened.core
    .rewind({
      commandId: randomUUID(),
      messageId,
      mode: 'conversation-and-files',
      previewId: 'preview-1',
      threadId,
    })
    .catch(() => undefined);
  await expect
    .poll(async () => types(await opened.core.read(threadId, 0)))
    .toEqual(['thread.rewind.started']);
  // The process stops here: its store closes under the started rewind, so no
  // outcome is ever committed by this host.
  await opened.store.close();

  const reopened = await openCore(root, files);
  cleanup.push(async () => {
    await reopened.core.close();
    await reopened.store.close();
  });
  const rows = await reopened.core.read(threadId, 0);
  expect(types(rows)).toEqual(['thread.rewind.started', 'thread.rewind.interrupted']);
  expect(rows.at(-1)?.event).toMatchObject({ phase: 'rewind', type: 'thread.rewind.interrupted' });
  restore.reject(new Error('the stopped host never restores'));
});

test('a started host lends Core its platform’s snapshot owner, so a client preview can restore files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-rewind-runtime-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const files: HostRewindFiles = {
    apply: async () => [],
    drift: async () => [],
    preview: async () => ({ previewId: 'preview-1' }),
    redo: async () => [],
    redoConflicts: async () => [],
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform(files));
  cleanup.push(() => host.close());
  const client = await attachAgentHost(host.record);
  cleanup.push(() => client.close());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const messageId = randomUUID();
  const { runId } = await client.request('run/start', {
    commandId: messageId,
    modelId: 'scripted',
    prompt: 'First',
    threadId,
  });
  await expect
    .poll(async () =>
      (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
        ({ event }) => event.type === 'run.finished' && event.runId === runId
      )
    )
    .toBe(true);
  await expect(
    client.request('thread/rewind/preview', { messageId, threadId })
  ).resolves.toMatchObject({
    files: { available: true, fromRunId: runId, previewId: 'preview-1' },
  });
});
