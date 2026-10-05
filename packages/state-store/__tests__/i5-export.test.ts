// M0-A2 item 5 (spike test/i5-export.test.ts): export while streaming, byte-identical import round trip, import on
// another host (foreign lock takeover), and purge/GC racing an export. The streaming export runs here at 8 MB (the
// spike's mutation size); the 100 MB run is i5-export-100mb.integration.test.ts.
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ForeignLockError, RootLock, RootLockedError } from '../src/lock.js';
import type { AppendItem } from '../src/run-log-types.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, runTs } from './helpers/proc.js';
import { appendInputs, seedInputs, toItem } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';
import { bundleEvents, exportWhileStreaming } from './suites/export-while-streaming.js';

const T = 't1';
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const original = { closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, openSync: fs.openSync };
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  killKids();
  cleanupDirs();
});

async function smallBundle(): Promise<{ bundle: string; target: string }> {
  const store = await StateStore.open(freshDir('i5flush-source'));
  const bundle = join(freshDir('i5flush-bundle'), 'bundle');
  try {
    await appendInputs(store, T, seedInputs(3, 1, 83));
    await store.exportTo(bundle);
  } finally {
    await store.close();
  }
  return { bundle, target: join(freshDir('i5flush-target'), 'root') };
}

describe('item 5 · backup, export, import', () => {
  test('bundle import flushes writable regular-file handles without truncating copied bytes', async () => {
    const { bundle, target } = await smallBundle();
    const opened = new Map<number, { path: string; bytes: Buffer }>();
    const flushed: string[] = [];
    const closed: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      const fd = original.openSync(path, flags, mode);
      if (String(path).startsWith(`${target}${sep}`)) {
        opened.set(fd, {
          bytes: fs.readFileSync(join(bundle, relative(target, String(path)))),
          path: String(path),
        });
      }
      return fd;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      const copy = opened.get(fd);
      if (!copy) {
        throw new Error(`unexpected import flush descriptor ${fd}`);
      }
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      expect(fs.fstatSync(fd).size).toBe(copy.bytes.length);
      expect(copy.bytes.length).toBeGreaterThan(0);
      const bytes = Buffer.alloc(copy.bytes.length);
      expect(fs.readSync(fd, bytes, 0, bytes.length, 0)).toBe(bytes.length);
      expect(bytes).toEqual(copy.bytes);
      // Write the same final byte: actual descriptor write access, with identical content.
      expect(fs.writeSync(fd, copy.bytes, copy.bytes.length - 1, 1, copy.bytes.length - 1)).toBe(1);
      original.fsyncSync(fd);
      flushed.push(copy.path);
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      const copy = opened.get(fd);
      original.closeSync(fd);
      if (copy) {
        closed.push(copy.path);
        opened.delete(fd);
      }
    });
    syncBuiltinESMExports();
    const manifest = StateStore.importBundle(bundle, target);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const expected = [
      ...manifest.files
        .filter((file) => file.path !== 'manifest.json')
        .map((file) => join(target, file.path)),
      ...fs.readdirSync(join(bundle, 'lock')).map((name) => join(target, 'lock', name)),
    ];
    expect(flushed).toEqual(expected);
    expect(closed).toEqual(expected);
    expect(opened.size).toBe(0);
    for (const path of expected) {
      expect(fs.readFileSync(path)).toEqual(fs.readFileSync(join(bundle, relative(target, path))));
    }
  });

  test.each(['fsync', 'close'] as const)(
    'bundle import propagates %s failure and closes its copied-file descriptor',
    async (operation) => {
      const { bundle, target } = await smallBundle();
      const failure = Object.assign(new Error(`import ${operation} failed`), {
        code: operation === 'fsync' ? 'EPERM' : 'EIO',
      });
      const owned: Array<{ fd: number; path: string }> = [];
      const closed: number[] = [];
      let syncs = 0;
      vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
        const fd = original.openSync(path, flags, mode);
        if (String(path).startsWith(`${target}${sep}`)) {
          owned.push({ fd, path: String(path) });
        }
        return fd;
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        syncs++;
        if (operation === 'fsync') {
          throw failure;
        }
        original.fsyncSync(fd);
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        original.closeSync(fd);
        if (owned.some((entry) => entry.fd === fd)) {
          closed.push(fd);
          if (operation === 'close') {
            throw failure;
          }
        }
      });
      syncBuiltinESMExports();
      let observed: unknown;
      try {
        StateStore.importBundle(bundle, target);
      } catch (error) {
        observed = error;
      }
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      expect(observed).toBe(failure);
      expect(syncs).toBe(1);
      expect(owned).toHaveLength(1);
      expect(closed).toEqual(owned.map((entry) => entry.fd));
      const copy = owned[0];
      if (!copy) {
        throw new Error('import did not open a copied file');
      }
      expect(() => fs.fstatSync(copy.fd)).toThrow();
      expect(fs.readFileSync(copy.path)).toEqual(
        fs.readFileSync(join(bundle, relative(target, copy.path)))
      );
    }
  );

  test('export of an 8 MB thread while it streams is a consistent snapshot; import round-trips byte-identically', async () => {
    const res = await exportWhileStreaming(Number(process.env['STATE_STORE_THREAD_MB'] ?? '8'));
    process.stdout.write(`[i5 8MB] ${JSON.stringify(res)}\n`);
  }, 300_000);

  test('import on a different host: foreign lock refuses every takeover, including confirmation', async () => {
    const root = freshDir('i5f');
    const store = await StateStore.open(root, { host: 'hostA' });
    await appendInputs(store, T, seedInputs(20, 0, 83));
    const bundle = join(freshDir('i5fb'), 'bundle');
    await store.exportTo(bundle);
    await store.close();
    const root3 = join(freshDir('i5f3'), 'root');
    StateStore.importBundle(bundle, root3);
    expect(RootLock.inspect(root3)?.owner.host).toBe('hostA');

    let asked = false;
    await expect(
      StateStore.open(root3, {
        host: 'hostB',
        onForeignLock: () => {
          asked = true;
          return true;
        },
      })
    ).rejects.toThrow(ForeignLockError);
    expect(asked).toBe(false);
    expect(RootLock.inspect(root3)?.owner.host).toBe('hostA');
    await expect(StateStore.open(root3, { host: 'hostB' })).rejects.toThrow(ForeignLockError);
  });

  test('the same-host rule is unchanged: a live owner of this root is refused without asking; a dead one is broken', async () => {
    const root = freshDir('i5live');
    const p = runTs(fixture('store-proc.ts'), ['hold', root]);
    await p.line('holding');
    let asked = 0;
    const ask = (): boolean => {
      asked++;
      return true;
    };
    try {
      await expect(StateStore.open(root, { onForeignLock: ask })).rejects.toThrow(RootLockedError);
      expect(asked).toBe(0);
    } finally {
      p.p.kill('SIGKILL');
      await p.exit();
    }
    const s = await StateStore.open(root, { onForeignLock: ask });
    try {
      expect(asked).toBe(0);
      expect(RootLock.inspect(root)?.owner.pid).toBe(process.pid);
    } finally {
      await s.close();
    }
  });

  test('a purge or blob GC racing the export never yields an inconsistent bundle', async () => {
    const root = freshDir('i5race');
    const purged: number[] = [];
    const gcDuringExport: Array<readonly string[]> = [];
    const indexer = new TruthIndexer(root);
    let store: StateStore | null = null;
    const s = (): StateStore => store as StateStore;
    store = await StateStore.open(root, {
      hooks: {
        exportAfterSnapshot: async () => {
          await s().purge(T, 5);
          purged.push(5);
          await s().append([toItem(T, { content: 'after the snapshot', type: 'text' })]);
        },
        exportBeforeBlobs: async () => {
          const rep = await s().purge(T, 10);
          purged.push(10);
          gcDuringExport.push(rep.blobsDeleted);
        },
      },
      indexer,
    });
    try {
      const items: AppendItem[] = seedInputs(20, 10, 84).map((x, i) =>
        toItem(T, i === 4 ? { content: `${'z'.repeat(500)} event five`, type: 'text' } : x)
      );
      await s().append(items);
      await indexer.catchUp([T]);
      const before = await s().read(T);
      const k10Blob = (JSON.parse(before[9]?.raw ?? '{}') as { blob: string }).blob;
      const bundle = join(freshDir('i5rb'), 'bundle');
      const m = await s().exportTo(bundle);
      expect(purged).toEqual([5, 10]);
      const b = bundleEvents(bundle, T);
      const w = m.threads.find((t) => t.threadId === T)?.watermark;
      expect(b.items).toEqual(Array.from({ length: w ?? 0 }, (_, i) => String(i + 1)));
      // The snapshot is taken by VACUUM INTO: after purge 5 (made before the copy), before purge 10 (made after it).
      expect(b.events[4]?.raw).toBe('{"seq":5,"type":"purged"}');
      expect(b.events[9]?.raw).toBe(before[9]?.raw); // purge 10 came after the snapshot, so the bundle still references k10's blob...
      expect(existsSync(join(bundle, 'blobs', k10Blob))).toBe(true); // ...and the blob GC was deferred until the export finished
      expect(gcDuringExport).toEqual([[]]);
      expect(existsSync(join(root, 'blobs', k10Blob))).toBe(false); // then it ran
    } finally {
      await s().close();
      indexer.close();
    }
  });
});
