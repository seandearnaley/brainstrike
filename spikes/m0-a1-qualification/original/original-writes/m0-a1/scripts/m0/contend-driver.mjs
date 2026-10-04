// M0-A1 item 4 driver: creates one 100 MB file, then ROUNDS x variants (order rotates per round), one fresh process
// each. Variants: J (fs.fsync on the default 4-thread libuv pool), J+UV16 (UV_THREADPOOL_SIZE=16), J-worker (dedicated
// sync worker thread), S (writer worker). Writes <outJson> after every run.
// usage: node scripts/m0/contend-driver.mjs <rounds> <outJson> [variants=J,J+UV16,J-worker,S]
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadavg } from 'node:os';
import { join } from 'node:path';

const [roundsArg, OUT, varArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg);
const VARIANTS = (varArg ?? 'J,J+UV16,J-worker,S').split(',');
const TMP = process.env.M0_TMP ?? join(process.cwd(), 'tmp');
mkdirSync(TMP, { recursive: true });
const BIG = join(TMP, 'm0-100MB.bin');
if (!existsSync(BIG) || statSync(BIG).size !== 100 * 1024 * 1024) {
  const fd = openSync(BIG, 'w'); const chunk = randomBytes(1024 * 1024);
  for (let i = 0; i < 100; i++) writeSync(fd, chunk);
  closeSync(fd);
}
const run = (args, env) => new Promise((res, rej) => {
  const p = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code) => { const l = out.split('\n').find((x) => x.startsWith('M0CONTEND ')); if (code !== 0 || !l) rej(new Error(`exit ${code}\n${out.slice(-1500)}\n${err.slice(-3000)}`)); else res(JSON.parse(l.slice(10))); });
});
const records = [];
for (let i = 0; i < ROUNDS; i++) {
  const order = VARIANTS.map((_, k) => VARIANTS[(k + i) % VARIANTS.length]);
  for (const v of order) {
    const [cand, mod] = v.split('+');
    const env = mod === 'UV16' ? { UV_THREADPOOL_SIZE: '16' } : {};
    const la = loadavg().map((x) => +x.toFixed(2));
    const r = await run(['--import', 'tsx', 'scripts/m0/contend.ts', cand, BIG], env);
    records.push({ round: i, variant: v, ...r, driverLoadavg: la });
    console.log(`[${i} ${v}] idle p95=${r.idleReadMs.p95} loaded p95=${r.loadedReadMs.p95} (n=${r.loadedReadMs.n}) ratio=${r.ratioP95} bnd=${r.boundaries} (${r.boundariesPerSec}/s) sync p95=${r.syncSpanMs.p95} disp p95=${r.displayLatencyMs.p95} la1=${la[0]}`);
    writeFileSync(OUT, JSON.stringify({ records }, null, 1));
  }
}
