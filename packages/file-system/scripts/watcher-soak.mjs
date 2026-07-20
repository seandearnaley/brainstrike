#!/usr/bin/env node
// BST-568 slice 5: multi-root soak harness for the parcel watcher engine.
//
// Approximates the ticket's acceptance shape — six roots, a large synthetic
// tree, sustained churn — and reports resource usage over time so regressions
// in subscription cost or event handling surface as numbers, not vibes.
//
// Usage:
//   node scripts/watcher-soak.mjs --roots 6 --dirs-per-root 5000 --minutes 10
//
// Emits one JSON sample line every 30s and a final summary line:
//   { done: true, maxRssMb, endRssMb, totalEvents, batches, invalidations, ... }
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateSyntheticTree } from './watcher-benchmark.mjs';

const BACKEND_BY_PLATFORM = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

const SAMPLE_INTERVAL_MS = 30_000;
const CHURN_INTERVAL_MS = 250;

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dirs-per-root': { default: '5000', type: 'string' },
      minutes: { default: '10', type: 'string' },
      roots: { default: '6', type: 'string' },
    },
  });
  const rootCount = Number.parseInt(values.roots, 10);
  const dirsPerRoot = Number.parseInt(values['dirs-per-root'], 10);
  const minutes = Number.parseFloat(values.minutes);
  const backend = BACKEND_BY_PLATFORM[process.platform];
  if (!backend) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const watcher = await import('@parcel/watcher');

  const roots = [];
  for (let i = 0; i < rootCount; i += 1) {
    const root = await mkdtemp(join(tmpdir(), `bst568-soak-${i}-`));
    await generateSyntheticTree(root, { dirs: dirsPerRoot, filesPerDir: 1 });
    roots.push(root);
  }
  const stats = { batches: 0, errors: 0, events: 0 };
  const rssStart = rssMb();
  let maxRss = rssStart;

  const subscriptions = [];
  const subscribeStart = performance.now();
  for (const root of roots) {
    subscriptions.push(
      await watcher.subscribe(
        root,
        (error, events) => {
          if (error) {
            stats.errors += 1;
            return;
          }
          stats.batches += 1;
          stats.events += events.length;
        },
        { backend }
      )
    );
  }
  const subscribeAllMs = Math.round(performance.now() - subscribeStart);

  process.stdout.write(
    `${JSON.stringify({
      backend,
      dirsPerRoot,
      roots: rootCount,
      rssStartMb: rssStart,
      subscribeAllMs,
    })}\n`
  );

  const endAt = Date.now() + minutes * 60_000;
  let churnCounter = 0;
  const churnTimer = setInterval(() => {
    // Rotate churn across roots: create, modify, delete.
    const root = roots[churnCounter % roots.length];
    const file = join(root, 'd0', `churn-${churnCounter % 50}.txt`);
    churnCounter += 1;
    const op = churnCounter % 3;
    const action =
      op === 0
        ? writeFile(file, `v${churnCounter}`)
        : op === 1
          ? writeFile(file, `v${churnCounter}-mod`)
          : unlink(file).catch(() => undefined);
    void Promise.resolve(action).catch(() => undefined);
  }, CHURN_INTERVAL_MS);

  const sampleTimer = setInterval(() => {
    const rss = rssMb();
    maxRss = Math.max(maxRss, rss);
    process.stdout.write(
      `${JSON.stringify({
        batches: stats.batches,
        errors: stats.errors,
        events: stats.events,
        remainingMs: Math.max(0, endAt - Date.now()),
        rssMb: rss,
      })}\n`
    );
  }, SAMPLE_INTERVAL_MS);

  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  clearInterval(churnTimer);
  clearInterval(sampleTimer);

  await Promise.allSettled(subscriptions.map((s) => s.unsubscribe()));
  const endRss = rssMb();
  maxRss = Math.max(maxRss, endRss);
  process.stdout.write(
    `${JSON.stringify({
      batches: stats.batches,
      done: true,
      endRssMb: endRss,
      errors: stats.errors,
      events: stats.events,
      maxRssMb: maxRss,
      minutes,
      rssStartMb: rssStart,
    })}\n`
  );
  await Promise.allSettled(roots.map((root) => rm(root, { force: true, recursive: true })));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
