/**
 * BST-1929 out-of-page host sampler and contention guard for the committed
 * production benchmark (`vite.committed-benchmark.config.mts`). This file is
 * the sampler process and the process classification the guard shares with
 * it; the runner's ownership of the process, and the analysis of its samples,
 * are in `committed-benchmark-host.mts`.
 *
 * The sampler never touches the measured page. It runs as a separate,
 * lowest-priority process that leads its own process group. Every 500 ms it
 * appends one JSON line with:
 * - epoch-ms times at `ps` start and end, and the sampler's own cumulative CPU;
 * - `vm.loadavg`, via `os.loadavg()`;
 * - every process under the runner, with its cumulative CPU time;
 * - the top 15 processes by CPU;
 * - classified build, lint or test work, and unknown tool hosts.
 *
 * Privacy (6053016662, 6053174447): no process's argv or environment is read,
 * not even in memory. `ps` is asked only for pid, ppid, pcpu, time and `ucomm`.
 * `ucomm` is the kernel's name for the executable file (at most 16
 * characters). A process cannot rewrite it, unlike `comm`, which on macOS is
 * argv[0]: npm, for example, sets it to its whole command line.
 *
 * Classification and its blind spot: only an executable whose own name
 * identifies build, lint or test work is classified, and only those make the
 * guard refuse. Some hosts cannot be told apart without argv:
 * - tools hosted by `node` (vitest, tsc, vite, eslint, pnpm);
 * - `tsgo` (a type check, or an editor's language server);
 * - `Electron` (the desktop app under test, or an installed IDE that ships its
 *   binary under that name).
 *
 * They are reported as unknown with their CPU and never refuse. A slot's
 * quietness still rests mainly on the coordinator's quiet-machine procedure.
 *
 * Resolution: samples are 500 ms apart, and `ps` reports CPU time to 10 ms. A
 * job that starts and ends between two samples can be missed. A cumulative
 * sample cannot resolve a single token trial or millisecond CPU per token, so
 * use it only for windows that hold many samples. More CPU time per unit of
 * work does not uniquely prove CPU frequency or core placement.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SAMPLE_INTERVAL_MS = 500;
/** `ps -o time` resolution. */
export const CPU_TIME_RESOLUTION_SECONDS = 0.01;
/** Every field the sampler and guard ask `ps` for: identity, CPU and timing, never argv. */
export const PS_ARGS = ['-Ao', 'pid=,ppid=,pcpu=,time=,ucomm='] as const;
/**
 * Bounds one `ps` call. Measured: about 40 ms of CPU, and 50–118 ms wall time
 * inside contended runs, so this is a liveness bound, not a budget.
 */
export const PS_TIMEOUT_MS = 5000;
const TOP_PROCESSES = 15;
/** Snapshots written before the injected `crash` control throws. */
const CRASH_AFTER_SNAPSHOTS = 7;

export const BLIND_SPOT =
  'Tools hosted by node (vitest, tsc, vite, eslint, pnpm), tsgo and Electron cannot be classified without argv; they are reported as unknown with their CPU and never make the guard refuse. Jobs shorter than one 500 ms interval can be missed. A slot is quiet mainly by the coordinator’s quiet-machine procedure.';

export type Workload = 'build' | 'lint' | 'test-browser';

/** Executable names (`ucomm`, truncated to 16 characters) that identify their workload. */
export const CLASSIFIED_EXECUTABLES: ReadonlyMap<string, Workload> = new Map([
  ['biome', 'lint'],
  ['oxlint', 'lint'],
  ['esbuild', 'build'],
  ['turbo', 'build'],
  ['cargo', 'build'],
  ['rustc', 'build'],
  ['make', 'build'],
  ['clang', 'build'],
  ['clang++', 'build'],
  ['ld', 'build'],
  ['xcodebuild', 'build'],
  ['swift-frontend', 'build'],
  // Playwright's chrome-headless-shell and Chrome for Testing (the user's own
  // Google Chrome is `Google Chrome` / `Google Chrome He` and is not matched).
  ['chrome-headless-', 'test-browser'],
  ['Google Chrome fo', 'test-browser'],
]);

/**
 * Hosts whose workload cannot be told without argv: reported, never refused
 * on. `Electron` is here because installed apps also ship under that name
 * (`/Applications/Antigravity IDE.app/Contents/MacOS/Electron`, observed
 * resident since login).
 */
export const UNKNOWN_EXECUTABLES: ReadonlySet<string> = new Set([
  'node',
  'tsgo',
  'Electron',
  'Electron Helper',
]);

/** Everything persisted about a process: identity, CPU and nothing else. */
export interface ProcessRow {
  /** Cumulative CPU seconds (`ps -o time`, centisecond resolution). */
  readonly cpuSeconds: number;
  /** The executable's name (`ps -o ucomm`). */
  readonly executable: string;
  readonly pcpu: number;
  readonly pid: number;
  readonly ppid: number;
}

/** `[[dd-]hh:]mm:ss.cs` to seconds. */
export function parseCpuTime(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const parts = (clock ?? '').split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

/** Throws on a row it cannot parse: a dropped row could hide contention. */
export async function readProcesses(): Promise<readonly ProcessRow[]> {
  const { stdout } = await run('ps', PS_ARGS, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) {
        throw new Error(`Unparseable ps row for pid ${/^\s*(\d+)/.exec(line)?.[1] ?? '?'}.`);
      }
      return {
        cpuSeconds: parseCpuTime(match[4] ?? '0'),
        executable: match[5] ?? '',
        pcpu: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
      };
    });
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

export interface ContentionMatch extends ProcessRow {
  readonly workload: Workload;
}

export function contentionIn(rows: readonly ProcessRow[], runnerPid: number): ContentionMatch[] {
  const own = ownTree(rows, runnerPid);
  const matches: ContentionMatch[] = [];
  for (const row of rows) {
    const workload = own.has(row.pid) ? undefined : CLASSIFIED_EXECUTABLES.get(row.executable);
    if (workload) {
      matches.push({ ...row, workload });
    }
  }
  return matches;
}

export function unknownIn(rows: readonly ProcessRow[], runnerPid: number): ProcessRow[] {
  const own = ownTree(rows, runnerPid);
  return rows.filter((row) => !own.has(row.pid) && UNKNOWN_EXECUTABLES.has(row.executable));
}

/** The blind spot's size at one instant: how many unknown hosts, and their CPU. */
export function unknownSummary(rows: readonly ProcessRow[]) {
  return {
    count: rows.length,
    cpuSeconds: Number(rows.reduce((total, row) => total + row.cpuSeconds, 0).toFixed(2)),
    pcpu: Number(rows.reduce((total, row) => total + row.pcpu, 0).toFixed(1)),
  };
}

async function snapshot(runnerPid: number) {
  const t = Date.now();
  const rows = await readProcesses();
  const tEnd = Date.now();
  const tree = descendantsOf(rows, runnerPid);
  const own = process.cpuUsage();
  return {
    contention: contentionIn(rows, runnerPid),
    loadavg: loadavg(),
    runnerCpuSeconds: rows.find((row) => row.pid === runnerPid)?.cpuSeconds,
    /** The runner's descendants: its build workers, browser, this sampler and its `ps`. */
    runnerTree: rows.filter((row) => tree.has(row.pid) && row.pid !== runnerPid),
    /** This sampler's own cumulative CPU; its `ps` children's cost is bounded by `tEnd - t`. */
    samplerCpuMs: (own.user + own.system) / 1000,
    t,
    tEnd,
    top: [...rows].sort((left, right) => right.pcpu - left.pcpu).slice(0, TOP_PROCESSES),
    unknown: unknownIn(rows, runnerPid),
  };
}

/** One JSONL line, exactly as the sampler writes it. */
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

// ---- The sampler process ----

/** Controls only: `crash` throws after a few valid snapshots; `hang` ignores SIGTERM. */
export type SamplerFault = 'crash' | 'hang';

async function sample(out: string, runnerPid: number, fault: SamplerFault | undefined) {
  writeFileSync(out, '');
  const started = Date.now();
  const parent = process.ppid;
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = fault !== 'hang';
  });
  for (let tick = 0; !stopping; tick += 1) {
    if (fault === 'crash' && tick === CRASH_AFTER_SNAPSHOTS) {
      throw new Error('BST-1929 control: injected sampler crash');
    }
    appendFileSync(out, `${JSON.stringify(await snapshot(runnerPid))}\n`);
    if (fault === 'hang' && tick === 0) {
      // An in-flight child that never finishes: only the owner's group kill ends it.
      await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    }
    if (process.ppid !== parent) {
      return; // Orphaned: the runner died without joining this sampler.
    }
    const next = started + (tick + 1) * SAMPLE_INTERVAL_MS;
    await delay(Math.max(0, next - Date.now()));
  }
}

if (import.meta.main) {
  const [out, runnerPid, fault] = process.argv.slice(2);
  if (!(out && runnerPid) || (fault !== undefined && fault !== 'crash' && fault !== 'hang')) {
    throw new Error('usage: committed-benchmark-sampler.mts <out.jsonl> <runner-pid> [crash|hang]');
  }
  await sample(out, Number(runnerPid), fault);
}
