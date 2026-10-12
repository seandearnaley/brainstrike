/**
 * One unreadable stored row must never brick the host. A thread whose rows
 * cannot be read (a missing spooled blob, or a row that fails its crc) opens
 * as damaged: it refuses to run, still deletes, and is gone after a restart.
 * Real StateStore and indexer; only the model is scripted.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { BLOBS_DIR, STATE_DB, StateStore, ThreadDamagedError } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { startAgentHost } from '../src/runtime.js';
import {
  blocked,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  toolCall,
} from './fixtures/child-run-host.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
/** One reply large enough that its committed rows spool into blobs. */
const LONG_REPLY = 'A long recorded reply. '.repeat(1200);

function longReplyModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'text-1', type: 'text-start' },
          { delta: LONG_REPLY, id: 'text-1', type: 'text-delta' },
          { id: 'text-1', type: 'text-end' },
          { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
}

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 2,
  readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  resolveModel: async () => longReplyModel(),
  tools: {},
};

async function openHost(root: string) {
  const native = await openIndexer(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [root],
      stateProjection: {
        mode: 'dev',
        module: new URL('../dist/state-projection.js', import.meta.url).href,
      },
      stateRoot: root,
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(native) });
  const close = async (core?: HostCore): Promise<void> => {
    await core?.close();
    await store.close();
    await native.close();
  };
  try {
    return { close, core: await HostCore.open(store, platform, () => () => undefined), store };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** A root with a thread that ran a spooling reply, and a healthy thread beside it. */
async function seededRoot(tag: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `bs-damaged-${tag}-`)));
  roots.push(root);
  const host = await openHost(root);
  try {
    const damaged = (await host.core.startThread({ commandId: randomUUID() })).threadId;
    const { runId } = await host.core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Reply at length.',
      threadId: damaged,
    });
    await expect
      .poll(async () =>
        (await host.core.read(damaged, 0)).some(
          ({ event }) => event.type === 'run.finished' && event.runId === runId
        )
      )
      .toBe(true);
    const healthy = (await host.core.startThread({ commandId: randomUUID() })).threadId;
    const blobs = (await host.store.read(damaged)).flatMap(({ event }) =>
      typeof event['blob'] === 'string' ? [event['blob']] : []
    );
    expect(blobs.length).toBeGreaterThan(0);
    return { blobs, damaged, healthy, root };
  } finally {
    await host.close(host.core);
  }
}

/** Opens over the damaged root and proves the thread is listed, refuses to run, and deletes. */
async function openDamaged(seeded: Awaited<ReturnType<typeof seededRoot>>): Promise<void> {
  const host = await openHost(seeded.root);
  try {
    expect(
      host.core
        .listThreads()
        .map(({ threadId }) => threadId)
        .sort()
    ).toEqual([seeded.damaged, seeded.healthy].sort());
    const listed = new Map(host.core.listThreads().map((thread) => [thread.threadId, thread]));
    // The list names the damage and keeps the store's dates; a readable thread carries none.
    expect(listed.get(seeded.damaged)?.damage).toMatch(/\S/u);
    expect(listed.get(seeded.damaged)?.createdAt).toBeGreaterThan(0);
    expect(listed.get(seeded.healthy)).not.toHaveProperty('damage');
    // Opening it reads the same reason the list names, not a store or file error.
    await expect(host.core.read(seeded.damaged, 0)).rejects.toThrow(
      `This thread's history cannot be read: ${listed.get(seeded.damaged)?.damage}`
    );
    expect(await host.core.read(seeded.healthy, 0)).not.toHaveLength(0);
    await expect(
      host.core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Run anyway.',
        threadId: seeded.damaged,
      })
    ).rejects.toThrow(/cannot be read, so it cannot run/u);
    await expect(host.core.deleteThread({ threadId: seeded.damaged })).resolves.toEqual({
      deleted: true,
      threadIds: [seeded.damaged],
    });
  } finally {
    await host.close(host.core);
  }
  const reopened = await openHost(seeded.root);
  try {
    expect(await reopened.store.threads()).toEqual([seeded.healthy]);
    expect(reopened.core.listThreads().map(({ threadId }) => threadId)).toEqual([seeded.healthy]);
  } finally {
    await reopened.close(reopened.core);
  }
}

const childCleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of childCleanup.splice(0).reverse()) {
    await close();
  }
});

/** A parent that delegates a child task the child never finishes before the restart. */
function delegatingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const names = (options.tools ?? []).map((tool) => tool.name);
      if (names.includes('agent-explore')) {
        return stream(
          toolCall(
            'agent-explore',
            { _background: { enabled: false }, prompt: 'BLOCK_TASK: outlive the host.' },
            'parent-call-1'
          )
        );
      }
      return blocked(options);
    },
  });
}

test("a damaged child still lists under its parent, and its parent's waiting run ends interrupted", async () => {
  const harness = await setupChildRunHost(delegatingModel(), childCleanup);
  const runId = await harness.start('Delegate work that outlives the host.');
  let child: string | undefined;
  await expect
    .poll(async () => {
      child = (await childThreads(harness))[0];
      return child;
    })
    .toBeDefined();
  const childThreadId = child as string;
  await rowsUntil(harness, childThreadId, (row) => row.event.type === 'run.started');
  // The child's run.started row fails its crc; its first row, with the origin, stays readable.
  const db = new DatabaseSync(join(harness.store.root, STATE_DB));
  try {
    db.prepare(
      `UPDATE run_events SET payload = replace(payload, '"type":', '"type" :')
       WHERE thread_id = ? AND type = 'run.started'`
    ).run(childThreadId);
  } finally {
    db.close();
  }
  await harness.crash();
  expect(
    harness
      .core()
      .listChildren(harness.threadId)
      .map(({ threadId }) => threadId)
  ).toEqual([childThreadId]);
  const parentRows = await harness.core().read(harness.threadId, 0);
  expect(parentRows.find(finished(runId))?.event).toMatchObject({ outcome: 'interrupted' });
  await expect(
    harness.core().startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Run the damaged child.',
      threadId: childThreadId,
    })
  ).rejects.toThrow(/cannot be read, so it cannot run/u);
});

test('a stored event the host schema rejects opens its thread damaged, not the host failed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-damaged-schema-')));
  roots.push(root);
  const threadId = randomUUID();
  const seed = await StateStore.open(root);
  try {
    await seed.append([{ event: { type: 'thread.started' }, threadId }]);
  } finally {
    await seed.close();
  }
  const host = await openHost(root);
  try {
    expect(host.core.listThreads().map((thread) => thread.threadId)).toEqual([threadId]);
    await expect(
      host.core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt: 'Run.', threadId })
    ).rejects.toThrow(/cannot be read, so it cannot run/u);
  } finally {
    await host.close(host.core);
  }
});

test('a thread whose spooled blob is missing opens damaged, deletes, and stays gone', async () => {
  const seeded = await seededRoot('blob');
  for (const hash of seeded.blobs) {
    await rm(join(seeded.root, BLOBS_DIR, hash), { force: true });
  }
  await openDamaged(seeded);
});

test('a thread with a crc-damaged row opens damaged, deletes with its blobs, and stays gone', async () => {
  const seeded = await seededRoot('crc');
  const db = new DatabaseSync(join(seeded.root, STATE_DB));
  try {
    db.prepare(
      `UPDATE run_events SET payload = replace(payload, '"type":', '"type" :') WHERE thread_id = ? AND seq = 2`
    ).run(seeded.damaged);
  } finally {
    db.close();
  }
  const probe = await StateStore.open(seeded.root);
  try {
    await expect(probe.read(seeded.damaged)).rejects.toBeInstanceOf(ThreadDamagedError);
  } finally {
    await probe.close();
  }
  await openDamaged(seeded);
  for (const hash of seeded.blobs) {
    expect(existsSync(join(seeded.root, BLOBS_DIR, hash))).toBe(false);
  }
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('a client opening a damaged thread reads the refusal as the host wrote it', async () => {
  const seeded = await seededRoot('client');
  for (const hash of seeded.blobs) {
    await rm(join(seeded.root, BLOBS_DIR, hash), { force: true });
  }
  const host = await startAgentHost({ lifetime: 'persistent', root: seeded.root }, platform);
  const client = await attachAgentHost(host.record);
  try {
    const { threads } = await client.request('thread/list', {});
    const damage = threads.find(({ threadId }) => threadId === seeded.damaged)?.damage;
    expect(damage).toMatch(/\S/u);
    // The text a user sees: the host's refusal, never the transport's wrapper around it.
    const exactly = (text: string) => new RegExp(`^${escapeRegExp(text)}$`, 'u');
    for (const method of ['thread/read', 'log/subscribe'] as const) {
      await expect(
        client.request(method, { fromSeq: 0, threadId: seeded.damaged })
      ).rejects.toThrow(exactly(`This thread's history cannot be read: ${damage}`));
    }
    await expect(
      client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Run anyway.',
        threadId: seeded.damaged,
      })
    ).rejects.toThrow(exactly(`This thread's history cannot be read, so it cannot run: ${damage}`));
  } finally {
    await client.close();
    await host.close();
  }
});
