// M0-A2 item 5a/5b (spike test/i5-export.test.ts "export of a MB thread while it streams ... import round-trips"): the
// bundle is a consistent snapshot (exactly seqs 1..w, byte-identical, w at least the tail when export was called), and an
// import re-exports byte-identically except the state DB's schema cookie (VACUUM INTO writes cookie + 1,
// sqlite3.c "Add one to the old schema cookie").
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { type LockOwner, RootLock } from '../../src/lock.js';
import { readAll, SqliteReader } from '../../src/sqlite-reader.js';
import { type Manifest, StateStore, sha256Hex } from '../../src/state-store.js';
import { cleanupDirs, freshDir, sleep } from '../helpers/fs.js';
import { appendInputs, type Input, prose, rng } from '../helpers/testkit.js';

const T = 't1';
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function seed(store: StateStore, mb: number): Promise<void> {
  const r = rng(81);
  let bytes = 0;
  let seq = 0;
  while (bytes < mb * 1024 * 1024) {
    const batch: Input[] = [];
    for (let i = 0; i < 1000 && bytes < mb * 1024 * 1024; i++) {
      seq++;
      if (seq % 100 === 0) {
        batch.push({ output: prose(r, 16 * 1024), type: 'tool-result' });
        bytes += 2300;
      } else {
        batch.push({ content: prose(r, 2000), type: 'text' });
        bytes += 2040;
      }
    }
    await appendInputs(store, T, batch);
  }
}

/** Bundle data files (everything except the lock and the manifest) as path -> sha256. */
export function dataFiles(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (r !== 'lock') {
          walk(join(d, e.name), r);
        }
        continue;
      }
      if (r !== 'manifest.json') {
        res[r] = sha256Hex(readFileSync(join(d, e.name)));
      }
    }
  };
  walk(dir, '');
  return res;
}

export function bundleEvents(
  dir: string,
  thread: string
): { items: string[]; events: Array<{ seq: number; raw: string }> } {
  const rd = new SqliteReader(dir);
  const all = [...readAll(rd, thread)];
  rd.close();
  return {
    events: all.flatMap((i) => (i.kind === 'event' ? [{ raw: i.raw, seq: i.seq }] : [])),
    items: all.map((i) => (i.kind === 'event' ? String(i.seq) : `gap:${i.fromSeq}-${i.toSeq}`)),
  };
}

export async function exportWhileStreaming(mb: number): Promise<Record<string, unknown>> {
  const root = freshDir('i5');
  const store = await StateStore.open(root, { host: 'hostA' });
  const res: Record<string, unknown> = { mb };
  try {
    await seed(store, mb);
    await store.setSetting('theme', 'dark');
    const lat: Array<{ t: number; ms: number }> = [];
    let streaming = true;
    const streamer = (async (): Promise<void> => {
      const r = rng(82);
      while (streaming) {
        const t0 = performance.now();
        await appendInputs(store, T, [{ content: prose(r, 200), type: 'text' }]);
        lat.push({ ms: performance.now() - t0, t: t0 });
        await sleep(1);
      }
    })();
    await sleep(200);
    const tailAtCall = ((await store.status(T)) as { tail: number }).tail;
    const bundle = join(freshDir('i5b'), 'bundle');
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    await sleep(20);
    const tE0 = performance.now();
    const m = await store.exportTo(bundle);
    const tE1 = performance.now();
    loop.disable();
    res['eventLoopMaxMsDuringExport'] = loop.max / 1e6;
    await sleep(200);
    streaming = false;
    await streamer;
    const w = m.threads.find((t) => t.threadId === T)?.watermark ?? -1;
    const during = lat.filter((x) => x.t >= tE0 && x.t <= tE1);
    res['export'] = {
      appendP95: pct(
        lat.map((x) => x.ms),
        95
      ),
      appendsDuring: during.length,
      files: m.files.length,
      maxAppendMsDuring: Math.max(0, ...during.map((x) => x.ms)),
      ms: tE1 - tE0,
      tailAtCall,
      watermark: w,
    };
    expect(during.length).toBeGreaterThan(0);

    // ---- consistency: exactly seqs 1..w, each byte-identical to the source; not older than the request -------------
    expect(w).toBeGreaterThanOrEqual(tailAtCall);
    const b = bundleEvents(bundle, T);
    expect(b.items).toEqual(Array.from({ length: w }, (_, i) => String(i + 1)));
    const src = (await store.read(T)).slice(0, w);
    expect(b.events.map((e) => sha256Hex(e.raw))).toEqual(src.map((e) => sha256Hex(e.raw)));
    const sdb = new Database(join(bundle, 'state.db'), { readonly: true });
    expect(sdb.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(sdb.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toEqual({
      value: 'dark',
    });
    sdb.close();
    for (const e of b.events) {
      const h = (JSON.parse(e.raw) as { blob?: string }).blob;
      if (h) {
        expect(sha256Hex(readFileSync(join(bundle, 'blobs', h)))).toBe(h);
      }
    }

    // ---- import into a fresh root (same host): the copied lock names another root, so the opener is asked ---------
    const root2 = join(freshDir('i5r2'), 'root');
    StateStore.importBundle(bundle, root2);
    expect(dataFiles(root2)).toEqual(dataFiles(bundle));
    const asked: LockOwner[] = [];
    const store2 = await StateStore.open(root2, {
      host: 'hostA',
      onForeignLock: (o) => {
        asked.push(o);
        return true;
      },
    });
    try {
      expect(asked.map((o) => o.root)).toEqual([RootLock.inspect(root)?.owner.root]);
      expect((await store2.read(T)).map((e) => sha256Hex(e.raw))).toEqual(
        src.map((e) => sha256Hex(e.raw))
      );
      const bundle2 = join(freshDir('i5b2'), 'bundle');
      const m2: Manifest = await store2.exportTo(bundle2);
      // Re-export of the import. Blobs: byte-identical. state.db: VACUUM INTO writes the source's schema cookie + 1, so
      // header bytes 40..43 differ, by design.
      const { ['state.db']: s1, ...rest1 } = dataFiles(bundle);
      const { ['state.db']: s2, ...rest2 } = dataFiles(bundle2);
      expect(rest2).toEqual(rest1);
      expect(m2.files.filter((f) => f.path !== 'state.db')).toEqual(
        m.files.filter((f) => f.path !== 'state.db')
      );
      const a = readFileSync(join(bundle, 'state.db'));
      const c = readFileSync(join(bundle2, 'state.db'));
      const diff: number[] = [];
      for (let i = 0; i < Math.max(a.length, c.length); i++) {
        if (a[i] !== c[i]) {
          diff.push(i);
        }
      }
      expect(a.length).toBe(c.length);
      expect(diff.every((i) => i >= 40 && i <= 43)).toBe(true);
      expect(c.readUInt32BE(40)).toBe(a.readUInt32BE(40) + 1);
      res['roundTrip'] = {
        files: Object.keys(rest1).length + 1,
        stateDbDiffOffsets: diff,
        stateDbSame: s1 === s2,
      };
    } finally {
      await store2.close();
    }
    return res;
  } finally {
    await store.close();
    cleanupDirs();
  }
}
