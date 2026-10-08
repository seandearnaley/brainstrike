/**
 * BST-1929 out-of-page host sampler and contention guard for the committed
 * production benchmark (`vite.committed-benchmark.config.mts`).
 *
 * It never touches the measured page. The runner spawns this file as a
 * separate, lowest-priority child process. Every 500 ms it appends one JSON
 * line with:
 * - epoch-ms times at ps start and ps end, and the sampler's own cumulative
 *   CPU (its overhead);
 * - `vm.loadavg`, via `os.loadavg()`;
 * - the top 15 processes by CPU;
 * - the cumulative CPU time of every Chromium process under the runner,
 *   especially each `--type=renderer`;
 * - any other build, lint or test work observed on the machine.
 *
 * The runner stops it with SIGTERM and joins it before reporting.
 *
 * Privacy: argv is read in memory only, to match contention and classify the
 * runner's Chromium processes. Nothing persisted carries argv, environment or
 * user content. A process is recorded only by pid, CPU and timing, its
 * executable name (`ps` `ucomm`, at most 16 characters), and the
 * `.claude/worktrees/<name>` it runs from. A contention match adds the
 * pattern it matched.
 *
 * Resolution: samples are 500 ms apart, and `ps` reports CPU time to 10 ms. A
 * cumulative sample cannot resolve a single token trial, or millisecond CPU per
 * token. Use it only for windows that hold many samples. More CPU time per
 * unit of work does not uniquely prove CPU frequency or core placement.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SAMPLE_INTERVAL_MS = 500;
/** `ps -o time` resolution. */
export const CPU_TIME_RESOLUTION_SECONDS = 0.01;
const TOP_PROCESSES = 15;
/** `ps` pads `ucomm` (the kernel's MAXCOMLEN executable name) to exactly this width. */
const UCOMM_WIDTH = 16;
const PS_ROW = new RegExp(
  `^\\s*(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+(\\S+) (.{${UCOMM_WIDTH}}) ?(.*)$`
);
const WORKTREE = /\.claude\/worktrees\/([\w.-]+)/;

export interface ProcessRow {
  /** In memory only: never persisted. */
  readonly args: string;
  /** Cumulative CPU seconds (`ps -o time`, centisecond resolution). */
  readonly cpuSeconds: number;
  /** The executable name (`ps -o ucomm`). */
  readonly executable: string;
  readonly pcpu: number;
  readonly pid: number;
  readonly ppid: number;
}

/**
 * Other build, lint or test work. Matched on argv in memory. The runner's own
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

/** Throws on a row it cannot parse: a dropped row could hide contention. */
export async function readProcesses(): Promise<readonly ProcessRow[]> {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,pcpu=,time=,ucomm=,args=', '-ww'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = PS_ROW.exec(line);
      if (!match) {
        throw new Error(`Unparseable ps row for pid ${/^\s*(\d+)/.exec(line)?.[1] ?? '?'}.`);
      }
      return {
        args: match[6] ?? '',
        cpuSeconds: parseCpuTime(match[4] ?? '0'),
        executable: (match[5] ?? '').trimEnd(),
        pcpu: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
      };
    });
}

/** The persisted identity of a process: never its argv. */
export function identityOf(row: ProcessRow) {
  return {
    executable: row.executable,
    pid: row.pid,
    worktree: WORKTREE.exec(row.args)?.[1],
  };
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
  readonly executable: string;
  readonly pattern: string;
  readonly pid: number;
  readonly worktree: string | undefined;
}

export function contentionIn(rows: readonly ProcessRow[], runnerPid: number): ContentionMatch[] {
  const own = ownTree(rows, runnerPid);
  const matches: ContentionMatch[] = [];
  for (const row of rows) {
    const pattern = own.has(row.pid)
      ? undefined
      : CONTENTION_PATTERNS.find((candidate) => candidate.test(row.args));
    if (pattern) {
      matches.push({ ...identityOf(row), pattern: String(pattern) });
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
    .map((row) => ({ ...identityOf(row), cpuSeconds: row.cpuSeconds, pcpu: row.pcpu }));
  const runner = rows.find((row) => row.pid === runnerPid);
  const own = process.cpuUsage();
  return {
    chromium: chromiumUnder(rows, runnerPid),
    contention: contentionIn(rows, runnerPid),
    loadavg: loadavg(),
    runnerCpuSeconds: runner?.cpuSeconds,
    /** This sampler's own cumulative CPU; its `ps` children's cost is bounded by `tEnd - t`. */
    samplerCpuMs: (own.user + own.system) / 1000,
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
