// Kernel-sync attribution (M0-A1 scripts/m0/attribute.mjs, the S candidate). Joins a run's JS-side spans (run.ts raw
// file) with a kernel trace:
//   syncspy (darwin DYLD_INSERT_LIBRARIES, linux LD_PRELOAD): one TSV line per libc sync call, uv_hrtime clock
//   linux also: strace -f -ttt -T -y -e trace=fsync,fdatasync, whose syscall count must equal the interposer's count
// Every kernel sync inside the run window is classified:
//   display  : starting inside a display write span (the writer's NORMAL commits) -> must be 0
//   boundary : inside a boundary span (the FULL commit [+ checkpoint]) and on state.db-wal / state.db
//   lock / other
// Pass: display == 0, and every boundary span (one per step boundary per thread) contains >= 1 kernel sync of the right
// file. Prints `M0ATTR <json>`.
// usage: node attribute.mjs <raw.json> <syncspy.tsv> [strace.txt]
import { readFileSync } from 'node:fs';

const [rawFile, traceFile, straceFile] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
const { out } = raw;
const EPS = 0.05; // ms: tolerance for clock reads at the JS span edges (same clock on both sides; reported: `skew`)
const base = (p) => p.split('/').at(-1);

/** syncspy TSV: op tid is_main name t0 t1 fd rc errno path */
function parseSpy(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [op, tid, isMain, , t0, t1, , rc, , path] = l.split('\t');
      return {
        main: isMain === '1',
        op,
        path,
        rc: Number(rc),
        t0: Number(t0),
        t1: Number(t1),
        tid: Number(tid),
      };
    });
}
/** strace -f -ttt -T -y -e trace=fsync,fdatasync: syscall-level events (used for the count cross-check only) */
function parseStrace(file) {
  const evs = [];
  const open = new Map();
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    let m =
      /^(\d+)\s+(\d+\.\d+)\s+(fsync|fdatasync)\(\d+<(.*)>\)\s+=\s+(-?\d+).*<(\d+\.\d+)>\s*$/.exec(
        l
      );
    if (m) {
      evs.push({ op: m[3], path: m[4], rc: Number(m[5]), tid: Number(m[1]) });
      continue;
    }
    m = /^(\d+)\s+(\d+\.\d+)\s+(fsync|fdatasync)\(\d+<(.*)> <unfinished \.\.\.>/.exec(l);
    if (m) {
      open.set(m[1], { op: m[3], path: m[4], tid: Number(m[1]) });
      continue;
    }
    m = /^(\d+)\s+(\d+\.\d+)\s+<\.\.\. (fsync|fdatasync) resumed>.*=\s+(-?\d+)/.exec(l);
    if (m) {
      const st = open.get(m[1]);
      open.delete(m[1]);
      if (!st) {
        throw new Error(`resumed without start: ${l}`);
      }
      evs.push({ ...st, rc: Number(m[4]) });
      continue;
    }
    if (/(fsync|fdatasync)\(/.test(l)) {
      throw new Error(`unparsed strace line: ${l}`);
    }
  }
  if (open.size) {
    throw new Error(`unfinished strace calls: ${JSON.stringify([...open.values()])}`);
  }
  return evs;
}

const evs = parseSpy(traceFile).sort((a, b) => a.t0 - b.t0);
const byOp = (a) =>
  a.reduce((m, e) => {
    m[e.op] = (m[e.op] ?? 0) + 1;
    return m;
  }, {});
const straceCheck = straceFile
  ? (() => {
      const st = parseStrace(straceFile);
      return {
        equal: JSON.stringify(byOp(st)) === JSON.stringify(byOp(evs)),
        interposer: byOp(evs),
        strace: byOp(st),
      };
    })()
  : null;
if (out.clock !== 'uv_hrtime') {
  throw new Error(`raw file ${rawFile} was not recorded on the uv_hrtime clock`);
}
const inWin = evs.filter((e) => e.t0 >= out.window.t0 - EPS && e.t0 <= out.window.t1 + EPS);
const isLock = (e) => /[\\/]lock[\\/]/.test(e.path);
const rightFile = (e) => base(e.path) === 'state.db-wal' || base(e.path) === 'state.db';
const counts = {
  boundary: 0,
  display: 0,
  failed: 0,
  inWindow: inWin.length,
  lock: 0,
  other: 0,
  total: evs.length,
};
const display = [];
const other = [];
const spanHits = raw.syncSpans.map(() => 0);
// containment: the kernel call [t0,t1] lies inside the JS span [s.t0,s.t1] (JS reads the clock before and after it)
const inside = (e, s) => e.t0 >= s.t0 - EPS && e.t1 <= s.t1 + EPS;
for (const e of inWin) {
  if (e.rc !== 0) {
    counts.failed++;
  }
  if (isLock(e)) {
    counts.lock++;
    continue;
  }
  const i = raw.syncSpans.findIndex((s) => inside(e, s) && rightFile(e));
  if (i >= 0) {
    counts.boundary++;
    spanHits[i]++;
    continue;
  }
  if (raw.writeSpans.some((s) => e.t0 >= s.t0 - EPS && e.t0 <= s.t1 + EPS)) {
    counts.display++;
    display.push(e);
    continue;
  } // inside a NORMAL commit
  counts.other++;
  other.push(e);
}
const perThread = {};
raw.syncSpans.forEach((s, i) => {
  perThread[s.thread] ??= { boundaries: 0, kernelSyncs: 0, spansWithKernelSync: 0 };
  const t = perThread[s.thread];
  t.spansWithKernelSync += spanHits[i] > 0 ? 1 : 0;
  t.kernelSyncs += spanHits[i];
});
for (const [t, n] of Object.entries(out.boundariesByThread)) {
  perThread[t] ??= { boundaries: 0, kernelSyncs: 0, spansWithKernelSync: 0 };
  perThread[t].boundaries = n;
}
const everyBoundarySynced = Object.values(perThread).every(
  (t) => t.spansWithKernelSync >= t.boundaries && t.boundaries > 0
);
const ops = {};
for (const e of inWin.filter((x) => !isLock(x))) {
  ops[e.op] = (ops[e.op] ?? 0) + 1;
}
const res = {
  boundaries: out.boundaries,
  counts,
  displayExamples: display.slice(0, 5),
  ops,
  otherExamples: other.slice(0, 5).map((e) => ({ ...e, path: base(e.path) })),
  pass: {
    displaySyncs0: counts.display === 0,
    everyBoundaryHasKernelSync: everyBoundarySynced,
    noFailedSyncs: counts.failed === 0,
  },
  perThread,
  straceCheck,
  walCheckpoint: out.walCheckpoint,
};
process.stdout.write(`M0ATTR ${JSON.stringify(res)}\n`);
