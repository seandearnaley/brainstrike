// ADR-0011: a blob is removed only when no row names it, verified or damaged, and once nothing holds collection every
// blob on disk is named by some row. Generated sequences of appends, shared run snapshots, purges, thread deletes, GC
// holds, row damage and crashes run against a real StateStore in its own temp root. After every command the rows on
// disk are read directly: each hash a row names must exist, and while nothing holds collection, every blob must be
// named. The derived index is the TruthIndexer double, as in the other deletion tests.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fc from 'fast-check';
import { afterEach, expect, test } from 'vitest';
import { storedBlobRefs } from '../src/run-log-format.mjs';
import { BLOBS_DIR, largeText, STATE_DB, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(() => cleanupDirs());

const THREADS = ['a', 'b', 'c'] as const;
type ThreadId = (typeof THREADS)[number];

/** A small pool, so generated events share blobs across events and threads. */
const baselines = ['first baseline', 'second baseline', 'third baseline'].map((content) => ({
  content,
  hash: sha256Hex(content),
}));
/** Run configurations: runs with the same one share its snapshot blob by reference (ADR-0011 amendment). */
const snapshots = ['system prompt A', 'system prompt B'].map((prompt) => {
  const content = JSON.stringify({ system: prompt, tools: ['read', 'write'] });
  return { content, hash: sha256Hex(content) };
});
/** Tool outputs past the blob threshold spool their body into the event's own `blob`. */
const outputs = ['x', 'y'].map((letter) => largeText(letter.repeat(13 * 1024)));

/** What the generated history put on each thread, so commands pick real targets. */
interface ThreadModel {
  damaged: boolean;
  /** Unpurged event seqs. */
  live: number[];
}

interface Model {
  holds: number;
  readonly threads: Map<ThreadId, ThreadModel>;
}

class Real {
  readonly releases: Array<() => Promise<void>> = [];
  /** Set by a crash-in-purge command: the purge's truth commits, then the process "dies". */
  crashAfterPurgeTruth = false;
  #store: StateStore | undefined;
  #indexer: TruthIndexer | undefined;

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get store(): StateStore {
    if (!this.#store) {
      throw new Error('the store is not open');
    }
    return this.#store;
  }

  async open(): Promise<void> {
    this.crashAfterPurgeTruth = false;
    this.#indexer = new TruthIndexer(this.root);
    this.#store = await StateStore.open(this.root, {
      hooks: {
        purgeAfterTruth: () => {
          if (this.crashAfterPurgeTruth) {
            throw new Error('simulated crash after purge truth');
          }
        },
      },
      indexer: this.#indexer,
    });
  }

  /**
   * Ends this process's store as a crash does for durable state: the holds and anything they deferred are gone with
   * the process, and the next open recovers from what is on disk.
   */
  async crash(): Promise<void> {
    this.releases.length = 0;
    await this.#store?.close();
    this.#indexer?.close();
    this.#store = undefined;
  }

  async reopen(): Promise<void> {
    await this.open();
  }

  async dispose(): Promise<void> {
    for (const release of this.releases.splice(0)) {
      await release();
    }
    await this.crash();
  }
}

/** Every hash a stored row names, read straight from the state DB (verified or damaged rows alike). */
function namedHashes(root: string): Set<string> {
  const db = new Database(join(root, STATE_DB), { readonly: true });
  try {
    const rows = db.prepare('SELECT payload FROM run_events').all() as Array<{ payload: string }>;
    return new Set(rows.flatMap((row) => storedBlobRefs(row.payload)));
  } finally {
    db.close();
  }
}

const blobsOnDisk = (root: string): string[] =>
  readdirSync(join(root, BLOBS_DIR)).filter((name) => /^[a-f0-9]{64}$/u.test(name));

/** The two promises, checked against the files after every command. */
function checkInvariants(m: Model, r: Real): void {
  const named = namedHashes(r.root);
  for (const hash of named) {
    expect(existsSync(join(r.root, BLOBS_DIR, hash)), `named blob ${hash} is on disk`).toBe(true);
  }
  if (m.holds === 0) {
    expect(blobsOnDisk(r.root).filter((hash) => !named.has(hash))).toEqual([]);
  }
}

/** Rewrites one stored payload so its crc no longer matches, keeping (or not) a parseable body. */
function damageRow(root: string, threadId: string, seq: number, parseable: boolean): void {
  const db = new Database(join(root, STATE_DB));
  try {
    const { payload } = db
      .prepare('SELECT payload FROM run_events WHERE thread_id = ? AND seq = ?')
      .get(threadId, seq) as { payload: string };
    const damaged = parseable ? payload.replace('"type":', '"type" :') : `<${payload.slice(1)}`;
    db.prepare('UPDATE run_events SET payload = ? WHERE thread_id = ? AND seq = ?').run(
      damaged,
      threadId,
      seq
    );
  } finally {
    db.close();
  }
}

const threadOf = (m: Model, id: ThreadId): ThreadModel => {
  let thread = m.threads.get(id);
  if (!thread) {
    thread = { damaged: false, live: [] };
    m.threads.set(id, thread);
  }
  return thread;
};

type AppendItem = Parameters<StateStore['append']>[0][number];

/** Appends one event to a healthy thread (a damaged one refuses, the BST-2458 test.fails case below); the store assigns the seq. */
class Append implements fc.AsyncCommand<Model, Real> {
  readonly item: AppendItem;
  readonly label: string;
  readonly thread: ThreadId;
  constructor(thread: ThreadId, label: string, item: Omit<AppendItem, 'threadId'>) {
    this.thread = thread;
    this.label = label;
    this.item = { ...item, threadId: thread };
  }
  check(m: Readonly<Model>): boolean {
    return m.threads.get(this.thread)?.damaged !== true;
  }
  async run(m: Model, r: Real): Promise<void> {
    const [row] = await r.store.append([this.item]);
    threadOf(m, this.thread).live.push(row?.seq ?? -1);
    checkInvariants(m, r);
  }
  toString(): string {
    return `${this.label}(${this.thread})`;
  }
}

const poolAt = <T>(pool: readonly T[], i: number): T => pool[i % pool.length] as T;

const editOf = (picks: readonly number[]): Omit<AppendItem, 'threadId'> => {
  const blobs = [...new Set(picks)].map((i) => poolAt(baselines, i));
  return { blobs, event: { blobRefs: blobs.map((b) => b.hash), type: 'edit' } };
};

const runStartedOf = (config: number): Omit<AppendItem, 'threadId'> => {
  const snapshot = poolAt(snapshots, config);
  return {
    blobs: [snapshot],
    event: { blobRefs: [snapshot.hash], snapshotRef: snapshot.hash, type: 'run.started' },
  };
};

const toolResultOf = (output: number): Omit<AppendItem, 'threadId'> => {
  const spooled = poolAt(outputs, output);
  return {
    blobs: spooled.blob ? [spooled.blob] : [],
    event: { ...spooled.fields, type: 'tool-result' },
  };
};

class Purge implements fc.AsyncCommand<Model, Real> {
  readonly crash: boolean;
  readonly pick: number;
  readonly thread: ThreadId;
  constructor(thread: ThreadId, pick: number, crash: boolean) {
    this.thread = thread;
    this.pick = pick;
    this.crash = crash;
  }
  check(m: Readonly<Model>): boolean {
    const thread = m.threads.get(this.thread);
    // A crash while a hold defers collection leaks (the BST-2458 test.fails case below), so crashes come only while unheld.
    return (
      thread !== undefined &&
      !thread.damaged &&
      thread.live.length > 0 &&
      (!this.crash || m.holds === 0)
    );
  }
  async run(m: Model, r: Real): Promise<void> {
    const thread = threadOf(m, this.thread);
    const seq = thread.live[this.pick % thread.live.length] ?? -1;
    if (this.crash) {
      r.crashAfterPurgeTruth = true;
      await expect(r.store.purge(this.thread, seq)).rejects.toThrow(/simulated crash/u);
      await r.crash();
      m.holds = 0;
      // Truth is tombstoned and the intent is on disk: the referenced blob must still be there until recovery runs.
      checkInvariants({ ...m, holds: 1 }, r);
      await r.reopen();
    } else {
      await r.store.purge(this.thread, seq);
    }
    thread.live = thread.live.filter((s) => s !== seq);
    checkInvariants(m, r);
  }
  toString(): string {
    return `purge(${this.thread}, pick ${this.pick}${this.crash ? ', crash after truth' : ''})`;
  }
}

class DeleteThread implements fc.AsyncCommand<Model, Real> {
  readonly thread: ThreadId;
  constructor(thread: ThreadId) {
    this.thread = thread;
  }
  check(m: Readonly<Model>): boolean {
    return m.threads.has(this.thread);
  }
  async run(m: Model, r: Real): Promise<void> {
    await r.store.deleteThread(this.thread);
    m.threads.delete(this.thread);
    checkInvariants(m, r);
  }
  toString(): string {
    return `deleteThread(${this.thread})`;
  }
}

class Hold implements fc.AsyncCommand<Model, Real> {
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    r.releases.push(r.store.holdBlobGc());
    m.holds++;
    checkInvariants(m, r);
  }
  toString(): string {
    return 'holdBlobGc()';
  }
}

class Release implements fc.AsyncCommand<Model, Real> {
  readonly pick: number;
  constructor(pick: number) {
    this.pick = pick;
  }
  check(m: Readonly<Model>): boolean {
    return m.holds > 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    const [release] = r.releases.splice(this.pick % r.releases.length, 1);
    await release?.();
    m.holds--;
    checkInvariants(m, r);
  }
  toString(): string {
    return `release(pick ${this.pick})`;
  }
}

/** Damage needs the store closed, as an on-disk flip happens under no writer; generated only while nothing holds. */
class Damage implements fc.AsyncCommand<Model, Real> {
  readonly parseable: boolean;
  readonly pick: number;
  readonly thread: ThreadId;
  constructor(thread: ThreadId, pick: number, parseable: boolean) {
    this.thread = thread;
    this.pick = pick;
    this.parseable = parseable;
  }
  check(m: Readonly<Model>): boolean {
    const thread = m.threads.get(this.thread);
    return thread !== undefined && !thread.damaged && thread.live.length > 0 && m.holds === 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    const thread = threadOf(m, this.thread);
    await r.crash();
    damageRow(
      r.root,
      this.thread,
      thread.live[this.pick % thread.live.length] ?? -1,
      this.parseable
    );
    await r.reopen();
    thread.damaged = true;
    checkInvariants(m, r);
  }
  toString(): string {
    return `damage(${this.thread}, pick ${this.pick}, ${this.parseable ? 'crc only' : 'unparseable'})`;
  }
}

/** Only while nothing holds, for the reason Purge gives. */
class Crash implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>): boolean {
    return m.holds === 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    await r.crash();
    await r.reopen();
    checkInvariants(m, r);
  }
  toString(): string {
    return 'crash and reopen';
  }
}

const thread = fc.constantFrom(...THREADS);
const append = fc.oneof(
  fc
    .tuple(thread, fc.array(fc.nat(2), { maxLength: 3, minLength: 1 }))
    .map(([t, picks]) => new Append(t, `edit[${picks.join(',')}]`, editOf(picks))),
  fc
    .tuple(thread, fc.nat(1))
    .map(([t, config]) => new Append(t, `run.started#${config}`, runStartedOf(config))),
  fc
    .tuple(thread, fc.nat(1))
    .map(([t, output]) => new Append(t, `tool-result#${output}`, toolResultOf(output)))
);
const purge = fc
  .tuple(thread, fc.nat(), fc.boolean())
  .map(([t, pick, crash]) => new Purge(t, pick, crash));
const release = fc.nat().map((pick) => new Release(pick));
// Listed twice: appends and purges feed every other command, and a release needs an earlier hold.
const commands = [
  append,
  append,
  purge,
  purge,
  thread.map((t) => new DeleteThread(t)),
  fc.constant(new Hold()),
  release,
  release,
  fc
    .tuple(thread, fc.nat(), fc.boolean())
    .map(([t, pick, parseable]) => new Damage(t, pick, parseable)),
  fc.constant(new Crash()),
];

test('no named blob is ever removed, and nothing is left unnamed once collection is free', async () => {
  await fc.assert(
    fc.asyncProperty(fc.commands(commands, { maxCommands: 60, size: 'large' }), async (cmds) => {
      const real = new Real(freshDir('blob-gc-model'));
      await real.open();
      try {
        await fc.asyncModelRun(() => ({ model: { holds: 0, threads: new Map() }, real }), cmds);
        // Quiet: every hold released, then the same two checks.
        for (const release of real.releases.splice(0)) {
          await release();
        }
        checkInvariants({ holds: 0, threads: new Map() }, real);
      } finally {
        await real.dispose();
      }
    }),
    { numRuns: 40 }
  );
}, 60_000);

// BST-2458 product bug, found by the model above when a crash may follow a hold: the hold's deferred
// hashes live only in memory (StateDeletion #deferred), and the purge or delete drops its intent as soon as it defers.
// A close or crash before the release loses them, and nothing collects the blob afterwards. The host holds collection
// for a whole session whenever hydration found a damaged thread (thread-catalog.ts), so every purge in such a session
// leaves its blob on disk for good, though the purge promises no byte of the event is left in the blobs.
test.fails('a purge made while collection is held still collects its blob after a restart', async () => {
  const real = new Real(freshDir('blob-gc-held-restart'));
  await real.open();
  try {
    await real.store.append([{ ...toolResultOf(0), threadId: 'a' }]);
    real.releases.push(real.store.holdBlobGc());
    await real.store.purge('a', 1);
    await real.crash();
    await real.reopen();
    expect(blobsOnDisk(real.root)).toEqual([]);
  } finally {
    await real.dispose();
  }
});

// BST-2458 product bug, the same leak by another path: an append spools its blobs before the row commits, so a refused append, here to a
// damaged thread, leaves blobs no row names, and nothing collects them later. A crash between the blob write and the
// commit leaves the same orphan.
test.fails('an append the store refuses leaves no blob behind', async () => {
  const real = new Real(freshDir('blob-gc-refused-append'));
  await real.open();
  try {
    await real.store.append([{ event: { type: 'note' }, threadId: 'a' }]);
    await real.crash();
    damageRow(real.root, 'a', 1, true);
    await real.reopen();
    await expect(real.store.append([{ ...editOf([0]), threadId: 'a' }])).rejects.toThrow(
      /damaged|read-only/u
    );
    expect(blobsOnDisk(real.root)).toEqual([]);
  } finally {
    await real.dispose();
  }
});
