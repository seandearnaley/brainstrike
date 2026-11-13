// ADR-0011's blob collection as a model-based test: the model, its commands and the driver. Generated sequences of
// appends, shared run snapshots, purges, thread deletes, GC holds, row damage and crashes run against a real StateStore
// in its own temp root. After every command the rows on disk are read directly: each hash a row names must exist, and
// while nothing holds collection, every blob must be named. The derived index is the TruthIndexer double, as in the
// other deletion tests.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fc from 'fast-check';
import { expect } from 'vitest';
import { storedBlobRefs } from '../../src/run-log-format.mjs';
import { BLOBS_DIR, largeText, STATE_DB, StateStore, sha256Hex } from '../../src/state-store.ts';
import { cleanupDirs, freshDir } from './fs.ts';
import { TruthIndexer } from './truth-indexer.ts';

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

export class Real {
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

export const blobsOnDisk = (root: string): string[] =>
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
export function damageRow(root: string, threadId: string, seq: number, parseable: boolean): void {
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

/**
 * Appends one event to a healthy thread (a damaged one refuses, the BST-2458 test.fails case in
 * blob-gc-model.test.ts); the store assigns the seq.
 */
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

export const editOf = (picks: readonly number[]): Omit<AppendItem, 'threadId'> => {
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

export const toolResultOf = (output: number): Omit<AppendItem, 'threadId'> => {
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
    // A crash while a hold defers collection leaks (the BST-2458 test.fails case in blob-gc-model.test.ts), so
    // crashes come only while unheld.
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

/**
 * The generated property's share for one test file. Four files (blob-gc-model{,-2,-3,-4}.test.ts) run it, 40 cases in
 * all. Every case opens a store and reopens it at each crash or damage, about four opens a case and over half its
 * time, so one file of 40 cases took 52 s of its 60 s budget beside four other packages' suites, and timed out at
 * 60 s on a busier machine (BST-2494). Separate files run on separate workers.
 */
const GENERATED_RUNS_PER_FILE = 10;

/** No named blob is ever removed, and nothing is left unnamed once collection is free, over generated histories. */
export async function checkGeneratedHistories(): Promise<void> {
  try {
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
      { numRuns: GENERATED_RUNS_PER_FILE }
    );
  } finally {
    cleanupDirs();
  }
}
