#!/usr/bin/env node
// BST-568 slice 1: synthetic large-tree watcher benchmark.
//
// Generates a balanced synthetic directory tree, then measures @parcel/watcher
// subscribe latency, RSS growth, first-event latency, and event throughput
// during a write burst. On macOS it can also benchmark the current engine's
// primitive (recursive fs.watch) for comparison.
//
// Usage:
//   node scripts/watcher-benchmark.mjs --dirs 30000 --files-per-dir 2
//   node scripts/watcher-benchmark.mjs --dirs 30000 --engine fs-watch   (darwin/win32 only)
//
// Prints one JSON result line per engine run.
import { watch as fsWatch } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_FANOUT = 16;
const BURST_FILES = 200;
const BURST_SETTLE_MS = 2000;
const GENERATION_SETTLE_MS = 1500;
const FIRST_EVENT_TIMEOUT_MS = 10_000;

const BACKEND_BY_PLATFORM = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

/**
 * Create a balanced tree with exactly `dirs` directories under `root`, each
 * holding `filesPerDir` small files. Fanout is capped at MAX_FANOUT so large
 * trees gain depth instead of one flat directory with 30k children.
 *
 * @param {string} root existing empty directory
 * @param {{ dirs: number; filesPerDir: number }} shape
 */
export async function generateSyntheticTree(root, { dirs, filesPerDir }) {
  if (!Number.isInteger(dirs) || dirs <= 0) {
    throw new Error(`dirs must be a positive integer, got ${dirs}`);
  }
  if (!Number.isInteger(filesPerDir) || filesPerDir < 0) {
    throw new Error(`filesPerDir must be a non-negative integer, got ${filesPerDir}`);
  }

  // Breadth-first: parents queue holds directories that can still accept
  // children. Every created directory becomes a future parent, keeping the
  // tree balanced with fanout <= MAX_FANOUT at every level.
  const parents = [root];
  let created = 0;
  let parentIndex = 0;
  let childCounter = 0;

  while (created < dirs) {
    const parent = parents[parentIndex];
    const childrenOfParent = [];
    while (childrenOfParent.length < MAX_FANOUT && created < dirs) {
      const dirPath = join(parent, `d${childCounter}`);
      childCounter += 1;
      created += 1;
      childrenOfParent.push(dirPath);
      parents.push(dirPath);
    }
    parentIndex += 1;
    await Promise.all(childrenOfParent.map((dirPath) => mkdir(dirPath)));
    await Promise.all(
      childrenOfParent.flatMap((dirPath) =>
        Array.from({ length: filesPerDir }, (_, i) => writeFile(join(dirPath, `f${i}.txt`), 'x'))
      )
    );
  }
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

async function benchmarkParcel(root, shape) {
  const watcher = await import('@parcel/watcher');
  const backend = BACKEND_BY_PLATFORM[process.platform];
  if (!backend) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  // Let the OS event backlog from tree generation drain before subscribing;
  // FSEvents otherwise reports dropped events for the pre-subscribe burst.
  await new Promise((resolve) => setTimeout(resolve, GENERATION_SETTLE_MS));

  const rssBefore = rssMb();
  let eventCount = 0;
  const backendErrors = [];
  let sawFirstEvent = () => undefined;
  const firstEvent = new Promise((resolve) => {
    sawFirstEvent = resolve;
  });

  const subscribeStart = performance.now();
  const subscription = await watcher.subscribe(
    root,
    (error, events) => {
      if (error) {
        // A dropped-events error is a real backend outcome (FSEvents overflow
        // => the consumer must rescan the root). Record it as data.
        backendErrors.push(error.message);
        sawFirstEvent();
        return;
      }
      eventCount += events.length;
      sawFirstEvent();
    },
    { backend }
  );
  const subscribeMs = performance.now() - subscribeStart;

  const result = await measureBurst(root, firstEvent, () => eventCount);
  await subscription.unsubscribe();

  return {
    backend,
    backendErrors,
    engine: 'parcel',
    rssDeltaMb: Math.round((rssMb() - rssBefore) * 10) / 10,
    subscribeMs: Math.round(subscribeMs * 10) / 10,
    ...shape,
    ...result,
  };
}

async function benchmarkFsWatch(root, shape) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('recursive fs.watch comparison only supported on darwin/win32');
  }
  const rssBefore = rssMb();
  let eventCount = 0;
  let sawFirstEvent = () => undefined;
  const firstEvent = new Promise((resolve) => {
    sawFirstEvent = resolve;
  });

  const subscribeStart = performance.now();
  const watcher = fsWatch(root, { recursive: true }, () => {
    eventCount += 1;
    sawFirstEvent();
  });
  const subscribeMs = performance.now() - subscribeStart;

  const result = await measureBurst(root, firstEvent, () => eventCount);
  watcher.close();

  return {
    backend: 'node-recursive-fs-watch',
    engine: 'fs-watch',
    rssDeltaMb: Math.round((rssMb() - rssBefore) * 10) / 10,
    subscribeMs: Math.round(subscribeMs * 10) / 10,
    ...shape,
    ...result,
  };
}

async function measureBurst(root, firstEvent, readEventCount) {
  const burstDir = join(root, 'd0');
  const firstEventStart = performance.now();
  await writeFile(join(burstDir, 'first-probe.txt'), 'probe');
  await Promise.race([
    firstEvent,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`no first event within ${FIRST_EVENT_TIMEOUT_MS}ms`)),
        FIRST_EVENT_TIMEOUT_MS
      )
    ),
  ]);
  const firstEventMs = performance.now() - firstEventStart;

  const burstStart = performance.now();
  await Promise.all(
    Array.from({ length: BURST_FILES }, (_, i) =>
      writeFile(join(burstDir, `burst-${i}.txt`), String(i))
    )
  );
  await new Promise((resolve) => setTimeout(resolve, BURST_SETTLE_MS));
  const burstSeconds = (performance.now() - burstStart - BURST_SETTLE_MS) / 1000;
  const eventsPerSec =
    burstSeconds > 0 ? Math.round(readEventCount() / Math.max(burstSeconds, 0.001)) : 0;

  return {
    burstFiles: BURST_FILES,
    eventsObserved: readEventCount(),
    eventsPerSec,
    firstEventMs: Math.round(firstEventMs * 10) / 10,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dirs: { default: '30000', type: 'string' },
      engine: { default: 'parcel', type: 'string' },
      'files-per-dir': { default: '2', type: 'string' },
    },
  });
  const dirs = Number.parseInt(values.dirs, 10);
  const filesPerDir = Number.parseInt(values['files-per-dir'], 10);
  const engine = values.engine;
  if (engine !== 'parcel' && engine !== 'fs-watch') {
    throw new Error(`Unknown engine: ${engine} (expected parcel | fs-watch)`);
  }

  const root = await mkdtemp(join(tmpdir(), 'bst568-bench-'));
  try {
    const generateStart = performance.now();
    await generateSyntheticTree(root, { dirs, filesPerDir });
    const generateMs = Math.round(performance.now() - generateStart);

    const shape = { dirs, filesPerDir, generateMs };
    const result =
      engine === 'parcel'
        ? await benchmarkParcel(root, shape)
        : await benchmarkFsWatch(root, shape);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
