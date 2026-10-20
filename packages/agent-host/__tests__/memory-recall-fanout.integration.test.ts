/**
 * Delegated children started together each recall their Memory resource at
 * once, through the host's one state-index worker and its production request
 * deadline. A recall verifies against truth only the threads that hold its
 * candidate vectors, so the resource's settled history costs it nothing.
 *
 * Recorded on a desktop profile (2026-10-20): 110 resource threads, 81,197
 * events, 7 vectors in 2 threads. Each recall projected the truth of all 110
 * threads (~3 s in the one writer). The second recall's deadline, queued
 * behind the first, retired the worker, and the other two failed with it.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { getTimeoutMultiplier } from '@brainstrike/test-utils/test-timeouts';
import { Schema } from 'effect';
import { expect, onTestFinished, test } from 'vitest';
import { storedHostEvent } from '../src/event-storage.js';
import { openHostStateIndex } from '../src/host-state-index.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';

const recorded = Schema.decodeUnknownSync(Schema.Array(HostLogRowSchema), {
  errors: 'all',
  onExcessProperty: 'error',
})(recording);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/**
 * The incident's resource: its 110 settled threads, most of whose events were
 * stream chunks. The replayed chunks are sized so that one recall that projects
 * them costs what the incident's did on the recording machine (~3 s).
 */
const SETTLED_THREADS = 110;
const CHUNKS_PER_THREAD = 1300;
const CHILDREN = 4;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'recall-fanout-proof',
  provider: 'local',
} as const;
const vector = [1, 0, 0, 0];

/** The recorded approved run as a fresh thread: its own IDs, and its stream replayed `chunks` more times before it finishes. */
function recordedThread(chunks: number): {
  readonly rows: HostLogRow[];
  readonly threadId: string;
} {
  const ids = new Map<string, string>();
  const rows = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)))(
    JSON.parse(
      JSON.stringify(recorded).replace(UUID, (id) => {
        const fresh = ids.get(id) ?? randomUUID();
        ids.set(id, fresh);
        return fresh;
      })
    )
  );
  const [first] = rows;
  const stream = rows.filter((row) => row.event.type === 'stream.chunk');
  if (!first || stream.length === 0) {
    throw new Error('The recorded run has no committed stream');
  }
  const replayed: HostLogRow[] = [];
  while (replayed.length < chunks) {
    replayed.push(...stream.slice(0, chunks - replayed.length));
  }
  rows.splice(
    rows.findIndex((row) => row.event.type === 'run.finished'),
    0,
    ...replayed
  );
  return { rows: rows.map((row, index) => ({ ...row, seq: index + 1 })), threadId: first.threadId };
}

test(
  'children started together each recall a large settled resource within one worker deadline',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-recall-fanout-')));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    const resourceId = 'workspace';
    const store = await StateStore.open(root);
    onTestFinished(() => store.close());
    const settled = Array.from({ length: SETTLED_THREADS }, () =>
      recordedThread(CHUNKS_PER_THREAD)
    );
    const parent = recordedThread(0);
    const children = Array.from({ length: CHILDREN }, () => recordedThread(0));
    for (const { rows, threadId } of [...settled, parent, ...children]) {
      await store.append(rows.map((row) => storedHostEvent(threadId, row.event)));
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

    const index = await openHostStateIndex(root, [resourceId]);
    onTestFinished(() => index.close());
    // The parent's answer is the resource's one recalled message, as in the incident.
    const answer = parent.rows.findLast((row) => row.event.type === 'model.step');
    if (!answer) {
      throw new Error('The recorded run has no committed answer');
    }
    const message = { messageId: JSON.stringify([parent.threadId, answer.seq]), seq: answer.seq };
    const scope = { resourceId, rootId: index.rootId, threadId: parent.threadId };
    const plan = await index.vectors.prepareStateMessageVectors({
      messages: [message],
      profile,
      scope,
    });
    await index.vectors.upsertStateMessageVectors({
      embeddings: [{ messageId: message.messageId, vectors: [vector] }],
      plan,
    });

    const recalls = await Promise.allSettled(
      children.map(({ threadId }) =>
        index.vectors.queryStateMessageVectors({
          limit: 5,
          profile,
          scope: { ...scope, threadId },
          vector,
        })
      )
    );
    expect(recalls).toEqual(
      children.map(() => ({
        status: 'fulfilled',
        value: [expect.objectContaining({ ...message, score: 1, threadId: parent.threadId })],
      }))
    );
  },
  120_000 * getTimeoutMultiplier()
);
