import { blobsOf } from '@brainstrike/state-store/run-log-format';
import type { WebStateAppendRow } from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebDerivedIndex } from '../web-writer-client';
import { closeTabs, corpus, openTab, storeConfig, storeCorpus } from './writer-tabs';

afterEach(closeTabs);

/**
 * A thread that names a blob of its own, and a row of another thread naming a
 * different blob: copied into the thread, that blob is named twice.
 */
function threadAndForeignBlobRow(): {
  readonly foreign: (typeof corpus.rows)[number];
  readonly threadId: string;
} {
  const named = corpus.rows.filter((row) => blobsOf(row[3]).length > 0);
  const threadId = named[0]?.[0];
  const foreign = named.find((row) => row[0] !== threadId);
  if (!(threadId && foreign)) {
    throw new Error('The corpus needs blob-naming rows in two threads');
  }
  return { foreign, threadId };
}

/** The first corpus event that names a blob, as the fresh store numbered it, and the blobs it names. */
function eventWithBlob(): {
  readonly hashes: readonly string[];
  readonly seq: number;
  readonly threadId: string;
} {
  const seqs = new Map<string, number>();
  for (const [threadId, , , body] of corpus.rows) {
    const seq = (seqs.get(threadId) ?? 0) + 1;
    seqs.set(threadId, seq);
    const hashes = blobsOf(body);
    if (hashes.length > 0) {
      return { hashes, seq, threadId };
    }
  }
  throw new Error('The corpus has no event that names a blob');
}

describe('deletion in the browser writer', () => {
  it('deletes a thread for every tab: its rows, its projection, and the blobs nothing else names', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    await storeCorpus(follower);
    const { foreign, threadId } = threadAndForeignBlobRow();
    const own = (await follower.storedBlobRefs(threadId)).hashes;
    const kept = blobsOf(foreign[3]);
    expect(own.length, 'blobs the thread names').toBeGreaterThan(0);
    // The thread names another thread's blob too, so deleting it must keep that one.
    await follower.append([[threadId, ...foreign.slice(1)] as unknown as WebStateAppendRow], {
      boundary: true,
    });
    const index = new WebDerivedIndex(follower);
    await index.catchUp();
    expect((await index.stats(threadId)).docs, 'projected docs').toBeGreaterThan(0);
    const others = corpus.threadIds.filter((other) => other !== threadId);
    const projections = await Promise.all(others.map((other) => index.stats(other)));
    expect(projections.every((stats) => stats.docs > 0)).toBe(true);

    const { deleted } = await follower.deleteThread(threadId);
    expect([...deleted].sort()).toEqual([...own].sort());
    expect((await writer.threads()).threads).not.toContain(threadId);
    for (const hash of own) {
      await expect(writer.readBlob(hash, 1_000_000)).rejects.toThrow('missing');
    }
    for (const hash of kept) {
      expect((await writer.readBlob(hash, 1_000_000)).content).not.toBeNull();
    }
    expect(await new WebDerivedIndex(writer).stats(threadId)).toEqual({
      cursor: 0,
      docs: 0,
      gaps: [],
    });
    writer.close();
    follower.close();

    // The other threads keep their projection, unchanged, across a reload.
    const reloaded = await openTab(config);
    const keptIndex = new WebDerivedIndex(reloaded);
    expect(await Promise.all(others.map((other) => keptIndex.stats(other)))).toEqual(projections);
    expect((await reloaded.threads()).threads).not.toContain(threadId);
  });

  it('purges an event: tombstoned in truth, unnamed by the projection, its blobs deleted', async () => {
    const tab = await openTab(storeConfig());
    await storeCorpus(tab);
    const index = new WebDerivedIndex(tab);
    await index.catchUp();
    const { hashes, seq, threadId } = eventWithBlob();

    const report = await tab.purge(threadId, seq);
    expect([...report.blobsDeleted].sort()).toEqual([...hashes].sort());
    const { rows } = await tab.read(threadId, seq, 1);
    expect(rows[0]?.payload).toContain('"type":"purged"');
    expect(Object.values(await index.gcCheck(corpus.threadIds, hashes))).toEqual(
      hashes.map(() => 0)
    );
    for (const hash of hashes) {
      await expect(tab.readBlob(hash, 1_000_000)).rejects.toThrow('missing');
    }
  });

  it('completes a purge that failed after its truth committed when the store next opens', async () => {
    const config = storeConfig();
    const tab = await openTab({ ...config, testHooks: { failPurgeAfterTruthOnce: true } });
    await storeCorpus(tab);
    await new WebDerivedIndex(tab).catchUp();
    const { hashes, seq, threadId } = eventWithBlob();

    await expect(tab.purge(threadId, seq)).rejects.toThrow('failed after its truth committed');
    // Truth is tombstoned, but the blobs wait for the intent's completion.
    expect((await tab.read(threadId, seq, 1)).rows[0]?.payload).toContain('"type":"purged"');
    for (const hash of hashes) {
      expect((await tab.readBlob(hash, 1_000_000)).content).not.toBeNull();
    }
    tab.close();

    const reopened = await openTab(config);
    for (const hash of hashes) {
      await expect(reopened.readBlob(hash, 1_000_000)).rejects.toThrow('missing');
    }
    expect(
      Object.values(await new WebDerivedIndex(reopened).gcCheck(corpus.threadIds, hashes))
    ).toEqual(hashes.map(() => 0));
  });
});
