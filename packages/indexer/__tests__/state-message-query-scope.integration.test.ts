// A Memory recall authorizes its candidate vectors against their threads' committed
// truth by reading only the rows each candidate's identity was read from. It projects
// no thread's history: on a desktop profile (2026-10-20), projecting all 110 threads
// of a resource cost each recall ~3 s in the one writer, though 2 held vectors, and
// projecting the threads holding vectors grows to the same cost once all of them do.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it } from 'vitest';
import { openDesktopIndex } from '../src/desktop-index-connection.js';
import { loadStateProjection } from '../src/state-projection.js';
import { IndexWriter } from '../src/store.js';

const profile = {
  dimensions: 4,
  distance: 'cosine',
  modelId: 'recall-scope-proof',
  provider: 'openai',
} as const;
const vector = [1, 0, 0, 0];
const resourceId = 'resource';

const owned: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

it('a resource recall verifies its candidates without projecting any thread history', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'state-message-query-scope-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  owned.push(() => store.close());
  const threads = ['one', 'two', 'settled-1', 'settled-2', 'settled-3'];
  for (const threadId of threads) {
    await store.append(
      Array.from({ length: 3 }, (_, index) => ({
        event: { content: `${threadId} answer ${index}`, type: 'text', v: 2 },
        threadId,
      }))
    );
    const current = await store.memory({ operation: 'read', resourceId });
    await store.memory({
      changes: [
        {
          entity: {
            id: threadId,
            kind: 'thread',
            payload: { id: threadId, metadata: {}, resourceId },
            threadId,
          },
          operation: 'put',
        },
      ],
      expectedRevision: current.revision,
      operation: 'commit',
      resourceId,
    });
  }
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root'],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-message-schema.mjs', import.meta.url).href,
    },
    stateResources: [{ resourceId, rootId: 'root' }],
    stateRoot: root,
  } as const;
  const loaded = await loadStateProjection(options.stateProjection, root);
  const { messages } = loaded;
  if (!messages) {
    throw new Error('The fixture producer projects message identities');
  }
  // Each canonical message projection is one thread's committed truth.
  const projected: string[] = [];
  const projection = {
    ...loaded,
    messages: (rows: Parameters<typeof messages>[0]) => {
      projected.push(...new Set(rows.map((row) => row.threadId)));
      return messages(rows);
    },
  };
  const writer = new IndexWriter(options, openDesktopIndex(options, projection), projection);
  owned.push(() => writer.close());
  const vectors = writer.requireState().messages;
  for (const threadId of ['one', 'two']) {
    const message = { messageId: JSON.stringify([threadId, 2]), seq: 2 };
    const plan = vectors.prepare({
      messages: [message],
      profile,
      scope: { resourceId, rootId: 'root', threadId },
    });
    vectors.upsert({ embeddings: [{ messageId: message.messageId, vectors: [vector] }], plan });
  }

  projected.length = 0;
  const hits = vectors.query({
    limit: 5,
    profile,
    scope: { resourceId, rootId: 'root', threadId: 'settled-1' },
    vector,
  });
  expect(hits.map((hit) => hit.threadId).sort()).toEqual(['one', 'two']);
  expect(projected).toEqual([]);

  // An explicit thread list is authorized against membership, and projects nothing either.
  projected.length = 0;
  expect(
    vectors.query({
      limit: 5,
      profile,
      scope: { resourceId, rootId: 'root', threadId: 'settled-1' },
      threadIds: ['two', 'settled-2'],
      vector,
    })
  ).toEqual([expect.objectContaining({ threadId: 'two' })]);
  expect(projected).toEqual([]);
});
