// M0-A1 item 4 (one fresh process): a "tool" reads a 100 MB file through fs.promises.readFile in a loop, first idle,
// then while the root and 8 background children stream many short steps (each `finish-step` = a boundary sync).
// The store is opened before the idle phase, so both phases run with the same threads alive.
// Prints `M0CONTEND <json>`. UV_THREADPOOL_SIZE is taken from the environment (libuv reads it at first pool use).
// usage: node --import tsx scripts/m0/contend.ts <candidate> <bigFile> [children=8] [steps=20] [deltas=60] [idleReads=15]
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { reasoning, text, toolCall } from '../../src/mock.js';
import { asCandidate, openStore } from '../../src/store-open.js';
import { clockNow } from '../../src/store.js';
import { makeHost, pct } from '../../test/helpers.js';

const [candArg, bigFile, childrenArg, stepsArg, deltasArg, idleArg] = process.argv.slice(2) as [string, string, ...string[]];
const cand = asCandidate(candArg);
const CHILDREN = Number(childrenArg ?? 8); const STEPS = Number(stepsArg ?? 20); const DELTAS = Number(deltasArg ?? 60); const IDLE = Number(idleArg ?? 15);
const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil((DELTAS * 6) / 57)).slice(0, DELTAS * 6);
const labels = Array.from({ length: CHILDREN }, (_, i) => `C${i}`);
const r3 = (x: number) => +x.toFixed(3);
const q = (a: number[]) => (a.length ? { n: a.length, p50: r3(pct(a, 50)), p95: r3(pct(a, 95)), max: r3(Math.max(...a)) } : { n: 0 });

const dir = mkdtempSync(join(process.env.M0_TMP ?? join(process.cwd(), 'tmp'), `contend-${cand}-`));
const store = await openStore(cand, join(dir, 'store'));
// control (M0_NOSYNC=1): same store and workload, boundary syncs skipped, to separate the syncs' effect from CPU load
const NOSYNC = process.env.M0_NOSYNC === '1';
if (NOSYNC) store.syncBoundary = () => Promise.resolve();
// idle baseline (M0_NOHOST=1): no host at all; the "loaded" phase is the same read loop for NOHOST_MS (sanity: ratio ~1)
const NOHOST = process.env.M0_NOHOST === '1';
const NOHOST_MS = 2500;
const { host } = await makeHost((c) => {
  const step = (last: boolean) => [...reasoning('thinking'), ...text(body, DELTAS), ...(last ? [] : toolCall('read_file', { path: `f${c.index}.ts` }))];
  if (c.label === 'root') return c.index === 0 ? labels.flatMap((l) => toolCall('delegate', { task: `stream ${l}`, label: l, background: true })) : step(c.index >= STEPS - 1);
  if (c.label === 'root-wake') return text('done');
  return step(c.index >= STEPS - 1);
}, { chunkDelayMs: 1, flushMs: 20, log: store, readMs: 5 });

const size = (await readFile(bigFile)).length; // warm the page cache
const idle: number[] = [];
const la0 = loadavg();
const elIdle = monitorEventLoopDelay({ resolution: 1 }); elIdle.enable();
for (let i = 0; i < IDLE; i++) { const t0 = performance.now(); await readFile(bigFile); idle.push(performance.now() - t0); }
elIdle.disable();
const elLoaded = monitorEventLoopDelay({ resolution: 1 }); elLoaded.enable();
const loadedFrom = clockNow();
let finished = false;
const t0 = performance.now();
const done = (NOHOST ? new Promise((r) => setTimeout(r, NOHOST_MS)) : host.sendUserMessage('thread-contend', 'go').then(() => host.waitIdle())).finally(() => { finished = true; });
const loaded: number[] = [];
while (!finished) { const s = performance.now(); await readFile(bigFile); loaded.push(performance.now() - s); }
await done;
elLoaded.disable();
const loadedTo = clockNow();
const wall = performance.now() - t0;
// event-loop write(2) time: J 'loop' modes write on this thread (span.loop); J-worker and S write on their workers
const mainWrites = store.stats.writeSpans.filter((w) => w.loop === true && w.t0 >= loadedFrom && w.t1 <= loadedTo).map((w) => w.t1 - w.t0);
await host.co.drainSyncs();
const la1 = loadavg();
const syncMs = store.stats.syncSpans.map((s) => s.t1 - s.t0);
const out = {
  candidate: cand, noSyncControl: NOSYNC, noHostBaseline: NOHOST, platform: `${process.platform}-${process.arch}`, cpus: availableParallelism(), uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? '4 (default)', fileBytes: size,
  workload: { children: CHILDREN, steps: STEPS, deltas: DELTAS }, wallMs: Math.round(wall), boundaries: host.co.boundarySyncs.length,
  boundariesPerSec: +(host.co.boundarySyncs.length / (wall / 1000)).toFixed(1), syncSpanMs: q(syncMs), syncFailures: host.co.syncFailures.map(String),
  idleReadMs: q(idle), loadedReadMs: q(loaded), ratioP95: idle.length && loaded.length ? +(pct(loaded, 95) / pct(idle, 95)).toFixed(3) : null,
  displayLatencyMs: q(host.co.displayLatencies), loadavg: { before: la0.map(r3), after: la1.map(r3) },
  eventLoopDelayMs: { idle: { p99: r3(elIdle.percentile(99) / 1e6), max: r3(elIdle.max / 1e6) }, loaded: { p99: r3(elLoaded.percentile(99) / 1e6), max: r3(elLoaded.max / 1e6) } },
  eventLoopWriteMs: { n: mainWrites.length, sum: r3(mainWrites.reduce((a, b) => a + b, 0)), max: mainWrites.length ? r3(Math.max(...mainWrites)) : 0, over1ms: mainWrites.filter((x) => x > 1).length, loadedPhaseMs: r3(loadedTo - loadedFrom) },
  raw: { idle: idle.map(r3), loaded: loaded.map(r3) },
};
await store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`M0CONTEND ${JSON.stringify(out)}`);
