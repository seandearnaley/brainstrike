// M0-A2 item 1 (spike test/i1-purge.test.ts "purge k from a MB thread while it streams"), on the state store: purge
// event k (holding the secret, inline and in a blob) from a large thread while it and a second thread keep streaming.
// When purge() resolves, no byte of k is left anywhere under the root; no other event is lost or reordered.
// The derived-store half of the spike test (FTS token remnant, vector bytes, derived row counts) belongs to PR 5's
// indexer and is not asserted here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { expect } from 'vitest';
import { TOMBSTONE_BODY, withSeq } from '../../src/run-log-format.mjs';
import { StateStore, sha256Hex } from '../../src/state-store.js';
import { cleanupDirs, freshDir, sleep } from '../helpers/fs.js';
import {
  appendInputs,
  byteSearch,
  HAS_LSOF,
  type Input,
  inodeOf,
  lsofUnder,
  prose,
  rng,
  SECRET,
  seedInputs,
  textBody,
} from '../helpers/testkit.js';
import { TruthIndexer } from '../helpers/truth-indexer.js';

const T = 't1';
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

export async function purgeWhileStreaming(mb: number): Promise<Record<string, unknown>> {
  const root = freshDir('i1');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  const res: Record<string, unknown> = { mb };
  try {
    // ---- seed ~mb of events; k sits in the middle ---------------------------------------------------------------------
    const r = rng(11);
    const target = mb * 1024 * 1024;
    let bytes = 0;
    let k = 0;
    let seq = 0;
    while (bytes < target) {
      const batch: Input[] = [];
      for (let i = 0; i < 1000 && bytes < target; i++) {
        seq++;
        if (k === 0 && bytes >= target / 2) {
          k = seq;
          batch.push(seedInputs(1, 1, 3)[0] as Input);
          bytes += 2400;
          continue;
        }
        if (seq % 100 === 0) {
          batch.push({ output: prose(r, 16 * 1024), type: 'tool-result' });
          bytes += 2300;
          continue;
        }
        batch.push({ content: prose(r, 2000), type: 'text' });
        bytes += 2040;
      }
      await appendInputs(store, T, batch);
    }
    await indexer.catchUp([T]);
    const before = new Map<number, string>();
    for (const e of await store.read(T)) {
      before.set(e.seq, sha256Hex(e.raw));
    }
    const seeded = before.size;
    const kRaw = (await store.read(T, k, 1))[0]?.raw ?? '';
    expect(kRaw).toContain(SECRET);
    const kBlob = (JSON.parse(kRaw) as { blob: string }).blob;

    // ---- positive controls: every instrument sees the secret before the purge -------------------------------------
    const secretBefore = byteSearch(root, SECRET);
    res['secretBefore'] = secretBefore;
    expect(Object.keys(secretBefore.files).some((f) => f.startsWith('blobs'))).toBe(true);
    expect(Object.keys(secretBefore.files).some((f) => f.startsWith('state.db'))).toBe(true);

    // ---- stream, purge mid-stream, keep streaming ----------------------------------------------------------------
    const expected = new Map(before);
    const lat: Array<{ t: number; ms: number }> = [];
    const lat2: Array<{ t: number; ms: number }> = [];
    let streaming = true;
    const other = (async (): Promise<void> => {
      const r3 = rng(77);
      while (streaming) {
        const t0 = performance.now();
        await appendInputs(store, 't2', [{ content: prose(r3, 200), type: 'text' }]);
        lat2.push({ ms: performance.now() - t0, t: t0 });
        await sleep(1);
      }
    })();
    const streamer = (async (): Promise<void> => {
      const r2 = rng(99);
      while (streaming) {
        const content = prose(r2, 200);
        const t0 = performance.now();
        const [s] = await appendInputs(store, T, [{ content, type: 'text' }]);
        lat.push({ ms: performance.now() - t0, t: t0 });
        expected.set(s as number, sha256Hex(withSeq(s as number, textBody(content))));
        await sleep(1);
      }
    })();
    await sleep(300);
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    await sleep(20); // the first tick is only a baseline
    const tP0 = performance.now();
    const rep = await store.purge(T, k);
    const tP1 = performance.now();
    loop.disable();
    res['eventLoopMaxMsDuringPurge'] = loop.max / 1e6;
    // The contract: when purge() resolves, the bytes are already gone (not "gone after the next checkpoint"). One
    // macrotask first, so the append queued behind the purge completes before this synchronous scan blocks the loop.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const atResolve = byteSearch(root, SECRET);
    res['secretAtPurgeResolve'] = atResolve;
    expect(atResolve.total).toBe(0);
    await sleep(300);
    streaming = false;
    await streamer;
    await other;
    expected.set(k, sha256Hex(withSeq(k, TOMBSTONE_BODY)));
    res['purge'] = rep;
    res['purgeWallMs'] = tP1 - tP0;
    const during = lat.filter((x) => x.t >= tP0 - 1 && x.t <= tP1);
    res['appends'] = {
      duringPurge: during.length,
      max: Math.max(...lat.map((x) => x.ms)),
      maxMsDuringPurge: Math.max(0, ...during.map((x) => x.ms)),
      p50: pct(
        lat.map((x) => x.ms),
        50
      ),
      p95: pct(
        lat.map((x) => x.ms),
        95
      ),
      total: lat.length,
    };
    expect(during.length).toBeGreaterThan(0); // the purge really happened while appends were in flight

    // ---- no other event lost or reordered -------------------------------------------------------------------------
    const after = await store.read(T);
    const tail = after.length;
    expect(after.map((e) => e.seq)).toEqual(Array.from({ length: tail }, (_, i) => i + 1));
    expect(tail).toBe(expected.size);
    expect(after.filter((e) => expected.get(e.seq) !== sha256Hex(e.raw)).map((e) => e.seq)).toEqual(
      []
    );
    res['events'] = { k, seeded, streamed: tail - seeded, tail };

    // ---- the blob is gone and the GC says so; nothing anywhere under the root --------------------------------------
    expect(existsSync(join(root, 'blobs', kBlob))).toBe(false);
    expect(rep.blobsDeleted).toEqual([kBlob]);
    expect(byteSearch(root, SECRET).total).toBe(0);

    // ---- no handle keeps pre-purge bytes alive (this process holds the writer and the indexer's reader) --------------
    if (HAS_LSOF) {
      const open = lsofUnder([process.pid], root).filter((f) => /^\d+$/.test(f.fd));
      for (const f of open) {
        expect(existsSync(f.name), `${f.name} held open but no longer in the tree`).toBe(true);
        expect(f.inode, `${f.name} held open is an old inode`).toBe(inodeOf(f.name));
      }
    }
    return res;
  } finally {
    await store.close();
    indexer.close();
    cleanupDirs();
  }
}
