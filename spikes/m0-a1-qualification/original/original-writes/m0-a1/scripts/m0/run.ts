// M0-A1 single run (fresh process) of the streaming workload on one candidate. Prints `M0RUN <json>`; writes the raw
// per-chunk latencies and wall-clock spans (for kernel-sync attribution) to <rawOut>.
// Workload: the root delegates N background children, then streams STEPS-1 steps of (reasoning + D text deltas +
// read_file) and a final text step; each child streams STEPS steps the same way (last step: no tool call). Every model
// chunk arrives 1 ms apart (mock), flushMs = 20, publish = after-commit. Every `finish-step` is a step boundary.
// usage: node --import tsx scripts/m0/run.ts <candidate> <rawOut> [children=3] [steps=4] [deltas=500]
import * as spy from './fs-spy-m0.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { reasoning, text, toolCall } from '../../src/mock.js';
import { asCandidate, openStore } from '../../src/store-open.js';
import { makeHost, pct } from '../../test/helpers.js';

const [candArg, rawOut, childrenArg, stepsArg, deltasArg] = process.argv.slice(2);
const cand = asCandidate(candArg);
const CHILDREN = Number(childrenArg ?? 3); const STEPS = Number(stepsArg ?? 4); const DELTAS = Number(deltasArg ?? 500);
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 20);
const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil((DELTAS * 6) / 57)).slice(0, DELTAS * 6);
const labels = Array.from({ length: CHILDREN }, (_, i) => `C${i}`);

const dir = mkdtempSync(join(process.env.M0_TMP ?? join(process.cwd(), 'tmp'), `run-${cand}-`));
const store = await openStore(cand, join(dir, 'store'));
const { host } = await makeHost((c) => {
  const step = (last: boolean) => [...reasoning('thinking '.repeat(20)), ...text(body, DELTAS), ...(last ? [] : toolCall('read_file', { path: `f${c.index}.ts` }))];
  if (c.label === 'root') return c.index === 0 ? labels.flatMap((l) => toolCall('delegate', { task: `stream ${l}`, label: l, background: true })) : step(c.index >= STEPS - 1);
  if (c.label === 'root-wake') return text('done');
  return step(c.index >= STEPS - 1);
}, { chunkDelayMs: 1, flushMs: FLUSH_MS, log: store, readMs: 5 });
let shown = 0;
host.onChunk(() => { shown++; });
spy.reset();
const la0 = loadavg();
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
const t0 = performance.now();
const tWall0 = performance.timeOrigin + t0;
await host.sendUserMessage('thread-m0', 'go');
await host.waitIdle();
const wall = performance.now() - t0;
await host.co.drainSyncs();
const tWall1 = performance.timeOrigin + performance.now();
h.disable();
const la1 = loadavg();
const fsCounts = spy.snapshot();
const co = host.co;
const boundariesByThread: Record<string, number> = {};
for (const b of co.boundarySyncs) boundariesByThread[b.threadId] = (boundariesByThread[b.threadId] ?? 0) + 1;
const syncsByThread: Record<string, number> = {};
for (const s of store.stats.syncSpans) syncsByThread[s.thread] = (syncsByThread[s.thread] ?? 0) + 1;
const syncMs = store.stats.syncSpans.map((s) => s.t1 - s.t0);
const r3 = (x: number) => +x.toFixed(3);
const q = (a: number[]) => (a.length ? { n: a.length, p50: r3(pct(a, 50)), p95: r3(pct(a, 95)), p99: r3(pct(a, 99)), max: r3(Math.max(...a)) } : { n: 0 });
const settings = 'settings' in store ? (store as { settings: unknown }).settings : undefined;
const out = {
  candidate: cand, platform: `${process.platform}-${process.arch}`, node: process.version, pid: process.pid, flushMs: FLUSH_MS,
  workload: { children: CHILDREN, steps: STEPS, deltas: DELTAS }, wallMs: Math.round(wall), shown, chunks: co.latencies.length,
  displayLatencyMs: q(co.displayLatencies), appendLatencyMs: q(co.latencies), flushCallMs: q(co.flushDurations),
  boundaries: co.boundarySyncs.length, boundariesByThread, syncsByThread, syncSpanMs: q(syncMs), syncFailures: co.syncFailures.map(String),
  syncKinds: [...new Set(store.stats.syncSpans.map((s) => s.kind))], writeSpans: store.stats.writeSpans.length,
  nodeFs: { fsync: fsCounts.fsync ?? 0, fsyncSync: fsCounts.fsyncSync ?? 0, fdatasync: fsCounts.fdatasync ?? 0, fdatasyncSync: fsCounts.fdatasyncSync ?? 0, writeSync: fsCounts.writeSync ?? 0, write: fsCounts.write ?? 0, openSync: fsCounts.openSync ?? 0 },
  eventLoopDelayMs: { resolution: 10, p50: r3(h.percentile(50) / 1e6), p99: r3(h.percentile(99) / 1e6), max: r3(h.max / 1e6) },
  loadavg: { before: la0.map(r3), after: la1.map(r3) }, settings,
  checkpoints: 'checkpoints' in store ? (store as { checkpoints: unknown[] }).checkpoints.length : undefined,
  window: { t0: tWall0, t1: tWall1 },
};
if (rawOut) writeFileSync(rawOut, JSON.stringify({ out, display: co.displayLatencies.map(r3), append: co.latencies.map(r3), writeSpans: store.stats.writeSpans, syncSpans: store.stats.syncSpans, boundarySyncs: co.boundarySyncs }));
await store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`M0RUN ${JSON.stringify(out)}`);
