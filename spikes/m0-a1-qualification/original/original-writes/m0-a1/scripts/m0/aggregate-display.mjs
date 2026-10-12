// M0-A1 items 1-3 aggregate: pooled per-chunk display latency per candidate (from the raw files), kernel attribution
// totals, boundary sync cost (JS-side span and kernel call), load averages. Prints JSON.
// usage: node scripts/m0/aggregate-display.mjs <display.json>
import { readFileSync } from 'node:fs';

const f = process.argv[2];
const d = JSON.parse(readFileSync(f, 'utf8'));
const rawDir = f.replace(/\.json$/, '-raw');
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))].toFixed(3); };
const by = new Map();
for (const r of d.records) { const k = r.candidate; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
const out = { file: f, tracer: d.tracer, workload: d.workload, candidates: {} };
for (const [c, rs] of by) {
  const disp = []; const flush = []; const syncJs = []; const kernel = [];
  for (const r of rs) {
    const raw = JSON.parse(readFileSync(`${rawDir}/${c}-${r.round}.json`, 'utf8'));
    disp.push(...raw.display);
    for (const s of raw.syncSpans) syncJs.push(s.t1 - s.t0);
  }
  for (const r of rs) if (r.attr?.kernelSyncMs?.n) kernel.push(r.attr.kernelSyncMs.p95);
  const att = rs.map((r) => r.attr).filter(Boolean);
  const sum = (k) => att.reduce((a, x) => a + (x.counts[k] ?? 0), 0);
  const ops = {}; for (const a of att) for (const [k, v] of Object.entries(a.ops)) ops[k] = (ops[k] ?? 0) + v;
  out.candidates[c] = {
    runs: rs.length, shownAll: rs.every((r) => r.shown === r.chunks), chunks: disp.length,
    displayMs: { p50: pct(disp, 50), p95: pct(disp, 95), p99: pct(disp, 99), max: pct(disp, 100) },
    displayP95PerRun: { min: Math.min(...rs.map((r) => r.displayLatencyMs.p95)), median: pct(rs.map((r) => r.displayLatencyMs.p95), 50), max: Math.max(...rs.map((r) => r.displayLatencyMs.p95)) },
    flushCallP95Median: pct(rs.map((r) => r.flushCallMs.p95), 50), flushCallMax: Math.max(...rs.map((r) => r.flushCallMs.max)),
    boundaries: rs.reduce((a, r) => a + r.boundaries, 0), jsSyncSpans: syncJs.length,
    syncSpanJsMs: { p50: pct(syncJs, 50), p95: pct(syncJs, 95), max: pct(syncJs, 100) },
    kernel: att.length ? {
      runs: att.length, display: sum('display'), boundary: sum('boundary'), other: sum('other'), failed: sum('failed'), ops,
      everyBoundaryHasKernelSyncAllRuns: att.every((a) => a.pass.everyBoundaryHasKernelSync), displaySyncs0AllRuns: att.every((a) => a.pass.displaySyncs0),
      kernelSyncP95PerRun: { min: kernel.length ? Math.min(...kernel) : null, median: pct(kernel, 50), max: kernel.length ? Math.max(...kernel) : null },
    } : null,
    elMaxMs: { median: pct(rs.map((r) => r.eventLoopDelayMs.max), 50), max: Math.max(...rs.map((r) => r.eventLoopDelayMs.max)) },
    loadavg1: { min: Math.min(...rs.map((r) => r.loadavg.before[0])), max: Math.max(...rs.map((r) => r.loadavg.before[0])) },
  };
}
// kernel sync duration pooled across all runs (needs the traces); computed from attr p95s above per run; pooled below
console.log(JSON.stringify(out, null, 1));
