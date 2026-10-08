/**
 * BST-1929 out-of-page host sampler and contention guard for the committed
 * production benchmark (`vite.committed-benchmark.config.mts`).
 *
 * It never touches the measured page. The runner spawns this file as a
 * separate, lowest-priority child process. Every 500 ms it appends one JSON
 * line with:
 * - epoch-ms times, at ps start and ps end;
 * - `vm.loadavg`, via `os.loadavg()`;
 * - the top 15 processes by CPU;
 * - the cumulative CPU time of every Chromium process under the runner,
 *   especially each `--type=renderer`;
 * - any other build, lint or test work observed on the machine.
 *
 * The runner stops it with SIGTERM and joins it before reporting.
 *
 * Resolution: a 500 ms cumulative CPU sample cannot resolve a single token
 * trial. Use it only for windows that hold many samples. More CPU time per
 * unit of work does not uniquely prove CPU frequency or core placement.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SAMPLE_INTERVAL_MS = 500;
const TOP_PROCESSES = 15;
const ARGS_CHARS = 240;

export interface ProcessRow {
  readonly args: string;
  /** Cumulative CPU seconds (`ps -o time`, centisecond resolution). */
  readonly cpuSeconds: number;
  readonly pcpu: number;
  readonly pid: number;
  readonly ppid: number;
}

/**
 * Other build, lint or test work. Matched on full argv. The runner's own
 * ancestors and descendants are always excluded, so its own `pnpm exec`,
 * Playwright browser and Vite workers never count.
 */
export const CONTENTION_PATTERNS: readonly RegExp[] = [
  /\bbiome\b/i,
  /\bultracite\b/i,
  /\btsc\b/,
  /\btsgo\b(?!.*--lsp)/,
  /\bvitest\b/i,
  /\bplaywright\b/i,
  /\bturbo\b/,
  /\bpnpm\b/,
  /\beslint\b/,
  /\boxlint\b/,
  /\bjest\b/,
  /\bknip\b/,
  /\breact-doctor\b/,
  /\bnode-gyp\b/,
  /\bvite\b/,
  /\bxcodebuild\b/,
  /\bcargo\b/,
];

/** `[[dd-]hh:]mm:ss.cs` to seconds. */
export function parseCpuTime(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const parts = (clock ?? '').split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

export async function readProcesses(): Promise<readonly ProcessRow[]> {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,pcpu=,time=,args=', '-ww'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) {
      rows.push({
        args: match[5] ?? '',
        cpuSeconds: parseCpuTime(match[4] ?? '0'),
        pcpu: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
      });
    }
  }
  return rows;
}

/** The runner's descendants (its browser, workers and this sampler), the runner itself. */
export function descendantsOf(rows: readonly ProcessRow[], runnerPid: number): Set<number> {
  const tree = new Set<number>([runnerPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return tree;
}

/**
 * Excluded from contention: the runner's descendants and its direct ancestor
 * chain (its own `pnpm exec`). Siblings under a shared ancestor, such as other
 * agents' commands under the same shell host, are NOT excluded.
 */
export function ownTree(rows: readonly ProcessRow[], runnerPid: number): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const own = descendantsOf(rows, runnerPid);
  for (let row = byPid.get(runnerPid); row && row.ppid > 1; row = byPid.get(row.ppid)) {
    own.add(row.ppid);
  }
  return own;
}

export interface ContentionMatch {
  readonly args: string;
  readonly pattern: string;
  readonly pid: number;
}

export function contentionIn(rows: readonly ProcessRow[], runnerPid: number): ContentionMatch[] {
  const own = ownTree(rows, runnerPid);
  const matches: ContentionMatch[] = [];
  for (const row of rows) {
    const pattern = own.has(row.pid)
      ? undefined
      : CONTENTION_PATTERNS.find((candidate) => candidate.test(row.args));
    if (pattern) {
      matches.push({ args: row.args.slice(0, ARGS_CHARS), pattern: String(pattern), pid: row.pid });
    }
  }
  return matches;
}

/** Chromium processes under the runner, classified by their `--type=`. */
function chromiumUnder(rows: readonly ProcessRow[], runnerPid: number) {
  const tree = descendantsOf(rows, runnerPid);
  return rows
    .filter((row) => tree.has(row.pid) && row.pid !== runnerPid && /chrom/i.test(row.args))
    .map((row) => ({
      cpuSeconds: row.cpuSeconds,
      pid: row.pid,
      ppid: row.ppid,
      type: /--type=([\w-]+)/.exec(row.args)?.[1] ?? 'browser',
    }));
}

async function snapshot(runnerPid: number) {
  const t = Date.now();
  const rows = await readProcesses();
  const tEnd = Date.now();
  const top = [...rows]
    .sort((left, right) => right.pcpu - left.pcpu)
    .slice(0, TOP_PROCESSES)
    .map((row) => ({
      args: row.args.slice(0, ARGS_CHARS),
      cpuSeconds: row.cpuSeconds,
      pcpu: row.pcpu,
      pid: row.pid,
    }));
  const runner = rows.find((row) => row.pid === runnerPid);
  return {
    chromium: chromiumUnder(rows, runnerPid),
    contention: contentionIn(rows, runnerPid),
    loadavg: loadavg(),
    runnerCpuSeconds: runner?.cpuSeconds,
    t,
    tEnd,
    top,
  };
}

async function sample(out: string, runnerPid: number): Promise<void> {
  writeFileSync(out, '');
  const started = Date.now();
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  for (let tick = 0; !stopping; tick += 1) {
    appendFileSync(out, `${JSON.stringify(await snapshot(runnerPid))}\n`);
    const next = started + (tick + 1) * SAMPLE_INTERVAL_MS;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
  }
}

if (import.meta.main) {
  const [out, runnerPid] = process.argv.slice(2);
  if (!(out && runnerPid)) {
    throw new Error('usage: committed-benchmark-sampler.mts <out.jsonl> <runner-pid>');
  }
  await sample(out, Number(runnerPid));
}
