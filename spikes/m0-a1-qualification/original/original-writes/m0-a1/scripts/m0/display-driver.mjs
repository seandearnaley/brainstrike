// M0-A1 items 1-3 driver: RUNS rounds x candidates, interleaved (the order rotates every round), one fresh process per
// run, each under the platform's kernel-sync tracer:
//   darwin: DYLD_INSERT_LIBRARIES=native/syncspy.dylib     linux: strace -f -ttt -T -y -e trace=fsync,fdatasync
//   win32:  none (no tracer; JS-side sync spans only)
// Each run is then attributed (scripts/m0/attribute.mjs). Writes <outJson> after every run.
// usage: node scripts/m0/display-driver.mjs <runs> <outJson> <candidates,comma> [children] [steps] [deltas]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';

const [runsArg, OUT, candArg, children = '3', steps = '4', deltas = '500'] = process.argv.slice(2);
const RUNS = Number(runsArg);
const CANDS = candArg.split(',');
const RAW = OUT.replace(/\.json$/, '-raw');
mkdirSync(RAW, { recursive: true });
const TRACER = process.env.M0_TRACER ?? (process.platform === 'darwin' ? 'syncspy' : process.platform === 'linux' ? 'strace' : 'none');
const DYLIB = resolve('native/syncspy.dylib');
if (TRACER === 'syncspy' && !existsSync(DYLIB)) throw new Error('build native/syncspy.dylib first (clang -O2 -dynamiclib -o native/syncspy.dylib native/syncspy.c)');

const run = (cmd, args, env = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => { p.kill('SIGKILL'); rej(new Error(`timed out: ${cmd} ${args.join(' ')}`)); }, 300_000);
  p.on('exit', (code) => { clearTimeout(t); if (code !== 0) rej(new Error(`exit ${code}: ${cmd} ${args.join(' ')}\n${out.slice(-2000)}\n${err.slice(-4000)}`)); else res(out); });
});
const line = (out, tag) => { const l = out.split('\n').find((x) => x.startsWith(`${tag} `)); if (!l) throw new Error(`no ${tag} line in:\n${out.slice(-2000)}`); return JSON.parse(l.slice(tag.length + 1)); };

const records = [];
for (let i = 0; i < RUNS; i++) {
  const order = CANDS.map((_, k) => CANDS[(k + i) % CANDS.length]);
  for (const c of order) {
    const raw = join(RAW, `${c}-${i}.json`);
    const trace = join(RAW, `${c}-${i}.${TRACER === 'strace' ? 'strace' : 'tsv'}`);
    rmSync(trace, { force: true });
    const la = loadavg().map((x) => +x.toFixed(2));
    const nodeArgs = ['--import', 'tsx', 'scripts/m0/run.ts', c, raw, children, steps, deltas];
    let out;
    if (TRACER === 'syncspy') out = await run(process.execPath, nodeArgs, { DYLD_INSERT_LIBRARIES: DYLIB, M0_SYNCSPY_LOG: resolve(trace) });
    else if (TRACER === 'strace') out = await run('strace', ['-f', '-ttt', '-T', '-y', '--seccomp-bpf', '-e', 'trace=fsync,fdatasync', '-o', trace, process.execPath, ...nodeArgs]);
    else out = await run(process.execPath, nodeArgs);
    const r = line(out, 'M0RUN');
    const attr = TRACER === 'none' ? null : line(await run(process.execPath, ['scripts/m0/attribute.mjs', raw, trace, TRACER === 'strace' ? 'linux' : 'darwin']), 'M0ATTR');
    records.push({ round: i, ...r, driverLoadavg: la, attr });
    console.log(`[${i} ${c}] disp p50/p95=${r.displayLatencyMs.p50}/${r.displayLatencyMs.p95} flush p95=${r.flushCallMs.p95} bnd=${r.boundaries} syncSpan p95=${r.syncSpanMs.p95 ?? '-'} ${attr ? `kernel display=${attr.counts.display} boundary=${attr.counts.boundary} pass=${JSON.stringify(attr.pass)} ksync p95=${attr.kernelSyncMs.p95}` : ''} la1=${la[0]}`);
    writeFileSync(OUT, JSON.stringify({ tracer: TRACER, workload: { children, steps, deltas }, records }, null, 1));
  }
}
