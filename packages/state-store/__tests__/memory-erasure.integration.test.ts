import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { CheckpointBlockedError } from '../src/sqlite-checkpoint.mjs';
import { STATE_DB, StateStore } from '../src/state-store.js';
import {
  MEMORY_ERASURE_RESOURCE,
  MEMORY_ERASURE_SECRET,
  MEMORY_ERASURE_THREAD,
  seedMemoryErasure,
} from './fixtures/memory-erasure-seed.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, runTs } from './helpers/proc.js';
import { byteSearch } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

const calculator = fileURLToPath(
  new URL('../../agent-host/dist/adapters/memory-storage-calculator.js', import.meta.url)
);
const resourceId = MEMORY_ERASURE_RESOURCE;
const threadId = MEMORY_ERASURE_THREAD;
afterEach(() => {
  killKids();
  cleanupDirs();
});

test('pinned WAL reader prevents strict WM/OM erasure acceptance; existing intent replay completes it', async () => {
  const root = freshDir('m3-memory-pin');
  let indexer = new TruthIndexer(root);
  let store = await StateStore.open(root, {
    busyTimeoutMs: 300,
    indexer,
    memoryCalculatorModule: calculator,
  });
  let reader: Database.Database | undefined;
  try {
    await seedMemoryErasure(store);
    expect(byteSearch(root, MEMORY_ERASURE_SECRET).total).toBeGreaterThan(0);
    reader = new Database(join(root, STATE_DB), { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM brainstrike_memory_entities').get();
    await expect(store.purge(threadId, 1)).rejects.toBeInstanceOf(CheckpointBlockedError);
    expect((await store.memory({ operation: 'read', resourceId })).entities).toEqual([]);
    expect(byteSearch(root, MEMORY_ERASURE_SECRET).total).toBeGreaterThan(0);
    reader.exec('COMMIT');
    reader.close();
    reader = undefined;
    await store.close();
    indexer.close();
    indexer = new TruthIndexer(root);
    store = await StateStore.open(root, { indexer, memoryCalculatorModule: calculator });
    expect(byteSearch(root, MEMORY_ERASURE_SECRET).total).toBe(0);
    expect((await store.memory({ operation: 'read', resourceId })).entities).toEqual([]);
    const inspect = new Database(join(root, STATE_DB), { readonly: true });
    try {
      expect(inspect.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(0);
    } finally {
      inspect.close();
    }
  } finally {
    reader?.close();
    await store.close();
    indexer.close();
  }
});

test('SIGKILL after truth erasure replays the retained resource policy before removing the intent', async () => {
  const root = freshDir('m3-memory-crash');
  const child = runTs(fixture('memory-erasure-proc.ts'), [root, calculator]);
  await child.line('memory-seeded');
  await child.exit();
  if (process.platform === 'win32') {
    expect(child.p.exitCode).not.toBe(0);
  } else {
    expect(child.p.signalCode).toBe('SIGKILL');
  }
  expect(() => process.kill(child.p.pid as number, 0)).toThrow();
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer, memoryCalculatorModule: calculator });
  try {
    expect((await store.memory({ operation: 'read', resourceId })).entities).toEqual([]);
    expect(byteSearch(root, MEMORY_ERASURE_SECRET).total).toBe(0);
    expect(await store.check()).toEqual({ gaps: 0, integrity: 'ok' });
  } finally {
    await store.close();
    indexer.close();
  }
});

test('deleting a thread keeps the shared working memory and observations, as legacy; its own memory goes', async () => {
  const root = freshDir('m3-memory-delete-keeps-wm');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer, memoryCalculatorModule: calculator });
  try {
    await seedMemoryErasure(store);
    await store.deleteThread(threadId);
    const { entities } = await store.memory({ operation: 'read', resourceId });
    expect(entities.map(({ id, kind, threadId: owner }) => ({ id, kind, owner }))).toEqual(
      expect.arrayContaining([
        { id: resourceId, kind: 'resource', owner: null },
        { id: expect.any(String), kind: 'observation', owner: null },
      ])
    );
    expect(entities).toHaveLength(2);
    expect(entities.find(({ kind }) => kind === 'resource')?.payload).toMatchObject({
      workingMemory: MEMORY_ERASURE_SECRET,
    });
    // This shared record holds no section attributed to the thread, so it is kept whole.
    expect(entities.find(({ kind }) => kind === 'observation')?.payload).toMatchObject({
      activeObservations: MEMORY_ERASURE_SECRET,
    });
  } finally {
    await store.close();
    indexer.close();
  }
});

test('held native calculation stays ahead of deletion; retired thread cannot recreate resource WM', async () => {
  const root = freshDir('m3-memory-held');
  let indexer = new TruthIndexer(root);
  let store = await StateStore.open(root, { indexer, memoryCalculatorModule: calculator });
  const heldModule = join(root, 'held-native-calculator.mjs');
  const entered = join(root, 'entered');
  const release = join(root, 'release');
  try {
    await seedMemoryErasure(store);
    await store.close();
    indexer.close();
    await writeFile(
      heldModule,
      `import { watch, existsSync } from 'node:fs';\nimport { writeFile } from 'node:fs/promises';\nimport { calculateMemoryMutation as native } from ${JSON.stringify(pathToFileURL(calculator).href)};\nexport { countObservationTokens } from ${JSON.stringify(pathToFileURL(calculator).href)};\nexport async function calculateMemoryMutation(snapshot, request) {\n  await writeFile(${JSON.stringify(entered)}, 'entered');\n  const watcher = watch(${JSON.stringify(root)});\n  try { await new Promise(resolve => { const check = () => { if (existsSync(${JSON.stringify(release)})) resolve(); }; watcher.on('change', check); check(); }); } finally { watcher.close(); }\n  return native(snapshot, request);\n}\n`
    );
    indexer = new TruthIndexer(root);
    store = await StateStore.open(root, { indexer, memoryCalculatorModule: heldModule });
    const held = store.memory({
      arguments: [
        {
          resource: {
            createdAt: new Date('2026-10-06T19:00:00Z').toISOString(),
            id: resourceId,
            updatedAt: new Date('2026-10-06T19:00:00Z').toISOString(),
            workingMemory: MEMORY_ERASURE_SECRET,
          },
        },
      ],
      method: 'saveResource',
      operation: 'native',
      ownerThreadId: threadId,
      resourceId,
    });
    await expect.poll(() => existsSync(entered)).toBe(true);
    let deleted = false;
    const deletion = store.deleteThread(threadId).then(() => {
      deleted = true;
    });
    await store.memory({ operation: 'read', resourceId });
    expect(deleted).toBe(false);
    expect(await store.threads()).toEqual([threadId]);
    await writeFile(release, 'release');
    await held;
    await deletion;
    // The held write committed ahead of the deletion; deleting the thread keeps
    // the shared working memory and observations, as legacy did.
    const kept = (await store.memory({ operation: 'read', resourceId })).entities;
    expect(kept.map(({ kind, threadId: owner }) => ({ kind, owner }))).toEqual(
      expect.arrayContaining([
        { kind: 'resource', owner: null },
        { kind: 'observation', owner: null },
      ])
    );
    expect(kept).toHaveLength(2);
    await expect(
      store.memory({
        arguments: [{ resource: { id: resourceId, workingMemory: MEMORY_ERASURE_SECRET } }],
        method: 'saveResource',
        operation: 'native',
        ownerThreadId: threadId,
        resourceId,
      })
    ).rejects.toThrow(/retired/);
    expect((await store.memory({ operation: 'read', resourceId })).entities).toEqual(kept);
    await store.reset();
    expect(existsSync(join(root, STATE_DB))).toBe(false);
  } finally {
    if (!existsSync(release)) {
      await writeFile(release, 'release');
    }
    await store.close();
    indexer.close();
  }
});
