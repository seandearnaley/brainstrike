/**
 * BST-1929: the benchmark runner's side of the out-of-page host sampler
 * (`committed-benchmark-sampler.mts`).
 *
 * Ownership: the sampler is owned from the moment it is spawned. It leads its
 * own process group, so the join can prove that it and any in-flight child
 * are gone. Every wait is bounded, and no cleanup throws, so one owner's
 * failure never skips another's release.
 *
 * Analysis: the sampler's own overhead, renderer CPU, contention, and the
 * guard's blind spot (unknown tool hosts), all from identity-only snapshots.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { getPriority, setPriority } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BLIND_SPOT,
  type ContentionMatch,
  type ProcessRow,
  PS_TIMEOUT_MS,
  SAMPLE_INTERVAL_MS,
  type SamplerFault,
  type Snapshot,
  unknownSummary,
} from './committed-benchmark-sampler.mts';

const SAMPLER_FILE = resolve(import.meta.dirname, 'committed-benchmark-sampler.mts');
/** A stopping sampler finishes at most one in-flight tick. */
const JOIN_TIMEOUT_MS = 2 * PS_TIMEOUT_MS;
/** The tick after a boundary starts within one interval and ends within one `ps` call. */
const COVERAGE_TIMEOUT_MS = 2 * SAMPLE_INTERVAL_MS + PS_TIMEOUT_MS;
const STARTUP_TIMEOUT_MS = 10_000;
/** Darwin reports a just-killed group as EPERM for about 10 ms before ESRCH. */
const GROUP_CONFIRMATION_MS = 2000;
/** The idle dummy exits as soon as its lifeline closes; this only bounds the wait. */
const DUMMY_EXIT_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const STDERR_CHARS = 16_384;

// ---- Ownership ----

interface Exit {
  readonly code: number | null;
  readonly error?: string;
  readonly signal: NodeJS.Signals | null;
}

export interface SamplerOwner {
  readonly child: ChildProcess;
  /** Settles on `close`: the process has exited and its stdio is drained. */
  readonly closed: Promise<Exit>;
  readonly file: string;
  readonly pid: number | undefined;
  readonly stderr: () => string;
}

/**
 * Spawns the sampler and registers its ownership at once, before anything can
 * fail. It leads its own process group (`detached`), so the join can prove
 * that its in-flight `ps` is gone too.
 */
export function spawnSampler(file: string, runnerPid: number, fault?: SamplerFault): SamplerOwner {
  const child = spawn(
    process.execPath,
    [SAMPLER_FILE, file, String(runnerPid), ...(fault ? [fault] : [])],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(0, STDERR_CHARS);
  });
  const closed = new Promise<Exit>((resolve_) => {
    child.once('close', (code, signal) => resolve_({ code, signal }));
    child.once('error', (error) => resolve_({ code: null, error: String(error), signal: null }));
  });
  return { child, closed, file, pid: child.pid, stderr: () => stderr };
}

/** Lowest priority, then the first snapshot: sampling is under way before any work. */
export async function startSampling({ child, file, pid }: SamplerOwner) {
  if (pid === undefined) {
    throw new Error('The host sampler did not start.');
  }
  setPriority(pid, 19);
  const priority = getPriority(pid);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!(await readFile(file, 'utf8').catch(() => '')).includes('\n')) {
    if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The host sampler produced no snapshot.');
    }
    await delay(POLL_MS);
  }
  return { priority, startedAt: Date.now() };
}

export function parseSnapshots(text: string): Snapshot[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Snapshot);
}

/**
 * Waits, bounded, for a snapshot that starts at or after `boundary`. Never
 * throws. The sampler may be mid-write, so only complete lines are read.
 */
export async function coverThrough({ child, file }: SamplerOwner, boundary: number) {
  const deadline = Date.now() + COVERAGE_TIMEOUT_MS;
  try {
    for (;;) {
      const text = await readFile(file, 'utf8').catch(() => '');
      const covering = parseSnapshots(text.slice(0, text.lastIndexOf('\n') + 1))
        .map((snapshot) => snapshot.t)
        .find((t) => t >= boundary);
      if (covering !== undefined) {
        return { boundary, covered: true, coveringT: covering, error: undefined };
      }
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
        return { boundary, covered: false, coveringT: undefined, error: undefined };
      }
      await delay(POLL_MS);
    }
  } catch (error) {
    return { boundary, covered: false, coveringT: undefined, error: String(error) };
  }
}

type GroupState = 'alive' | 'gone' | 'unsignalable';

/** ESRCH is the only proof a group is gone; Darwin answers EPERM while only zombies remain. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): GroupState {
  try {
    process.kill(-pgid, signal);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return 'gone';
    }
    if (code === 'EPERM') {
      return 'unsignalable';
    }
    throw error;
  }
}

async function confirmGroupGone(pgid: number): Promise<GroupState> {
  const deadline = Date.now() + GROUP_CONFIRMATION_MS;
  for (let state = signalGroup(pgid, 0); ; state = signalGroup(pgid, 0)) {
    if (state === 'gone' || Date.now() > deadline) {
      return state;
    }
    await delay(POLL_MS);
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, delay(ms, undefined)]);
}

export interface SamplerJoin {
  /** `close` arrived: the process exited and its stdio drained. */
  readonly closed: boolean;
  readonly code: number | null;
  readonly error: string | undefined;
  /** SIGTERM was not enough, so the sampler's group was killed. */
  readonly escalated: boolean;
  readonly group: GroupState | 'unknown';
  readonly joinedAt: number;
  readonly pid: number | undefined;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * The physical join, which never throws: SIGTERM, then a bounded wait for
 * `close`. If the sampler does not close, its whole group (the sampler and
 * its in-flight child, nothing else) is killed. Either way the group must then
 * be confirmed gone.
 */
export async function joinSampler(owner: SamplerOwner): Promise<SamplerJoin> {
  const { child, closed, pid } = owner;
  let escalated = false;
  let exit: Exit | undefined;
  let group: SamplerJoin['group'] = 'unknown';
  let error: string | undefined;
  try {
    child.kill('SIGTERM');
    exit = await within(closed, JOIN_TIMEOUT_MS);
    if (exit === undefined && pid !== undefined) {
      escalated = true;
      signalGroup(pid, 'SIGKILL');
      exit = await within(closed, JOIN_TIMEOUT_MS);
    }
    group = pid === undefined ? 'gone' : await confirmGroupGone(pid);
    error = exit?.error;
  } catch (caught) {
    error = String(caught);
  }
  return {
    closed: exit !== undefined,
    code: exit?.code ?? null,
    error,
    escalated,
    group,
    joinedAt: Date.now(),
    pid,
    signal: exit?.signal ?? null,
    stderr: owner.stderr(),
  };
}

/** A clean exit (code 0, no signal), joined through `close`, and its group confirmed gone. */
export function joinedCleanly(join: SamplerJoin): boolean {
  return (
    join.closed &&
    !join.escalated &&
    join.error === undefined &&
    join.code === 0 &&
    join.signal === null &&
    join.group === 'gone'
  );
}

// ---- The contention control's dummy ----

/**
 * The mid-run contention control's dummy, owned through pipes rather than a
 * pid. It must be reparented away from the runner (so it is not this run's
 * own work), so no ChildProcess handle reaches it directly. It inherits two
 * of the launcher's pipes instead:
 * - fd 3, its lifeline: it exits when the runner ends that pipe, or by itself
 *   after its lifetime. Not stdin, because Node destroys a child's stdin as
 *   soon as that child (here, the launcher) exits.
 * - stdout: the launcher's `close` fires only once every holder of its pipes,
 *   the dummy included, has exited.
 *
 * So releasing it never signals a pid that may have been recycled.
 */
export interface ContentionDummy {
  /** When the launcher's `close` proved the dummy gone, if it has. */
  readonly exitedAt: () => number | undefined;
  readonly lifeline: Socket;
  readonly lifelineError: () => string | undefined;
  /** For the report and `midRun` matching only; never signalled. */
  readonly pid: number;
}

/**
 * An idle clone of this Node binary, named so that the kernel's executable
 * name is a classified lint tool.
 */
export async function startContentionDummy(
  binary: string,
  lifetimeMs: number
): Promise<ContentionDummy> {
  mkdirSync(dirname(binary), { recursive: true });
  copyFileSync(process.execPath, binary, constants.COPYFILE_FICLONE);
  const script = `const l=new (require('node:net').Socket)({fd:3,readable:true,writable:false});l.on('end',()=>process.exit(0));l.on('error',()=>process.exit(0));l.resume();setTimeout(()=>process.exit(0),${lifetimeMs});`;
  const launcher = `const c=require('node:child_process').spawn(${JSON.stringify(binary)},['-e',${JSON.stringify(script)}],{detached:true,stdio:['ignore','inherit','ignore','inherit']});c.unref();process.stdout.write(c.pid+'\\n');`;
  const child = spawn(process.execPath, ['-e', launcher], {
    stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
  });
  const lifeline = child.stdio[3] as Socket;
  let exitedAt: number | undefined;
  let lifelineError: string | undefined;
  let out = '';
  child.once('close', () => {
    exitedAt = Date.now();
  });
  // Ending the lifeline after the dummy has gone can report EPIPE: kept, not thrown.
  lifeline.on('error', (error) => {
    lifelineError = String(error);
  });
  // Flowing, so the dummy's exit ends this side and `close` can fire.
  lifeline.resume();
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  const deadline = Date.now() + DUMMY_EXIT_TIMEOUT_MS;
  while (!out.includes('\n')) {
    if (Date.now() > deadline || exitedAt !== undefined) {
      lifeline.end();
      throw new Error('The contention dummy did not report its pid.');
    }
    await delay(POLL_MS);
  }
  return {
    exitedAt: () => exitedAt,
    lifeline,
    lifelineError: () => lifelineError,
    pid: Number(out.split('\n')[0]),
  };
}

/** Waits, bounded, for the launcher's `close` to prove the dummy gone. */
export async function awaitDummyExit(dummy: ContentionDummy, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (dummy.exitedAt() === undefined && Date.now() < deadline) {
    await delay(POLL_MS);
  }
  return dummy.exitedAt() !== undefined;
}

/**
 * Never throws and never signals. It closes the dummy's lifeline and waits,
 * bounded, for `close` to prove that exact instance gone. An exit it cannot
 * prove is reported, not forced.
 */
export async function stopContentionDummy(dummy: ContentionDummy, injected: Error | undefined) {
  const releasedAt = Date.now();
  const exitedBeforeRelease = dummy.exitedAt() !== undefined;
  try {
    dummy.lifeline.end();
    await awaitDummyExit(dummy, DUMMY_EXIT_TIMEOUT_MS);
    if (injected) {
      throw injected;
    }
    return {
      error: undefined,
      exitedAt: dummy.exitedAt(),
      exitedBeforeRelease,
      exitProven: dummy.exitedAt() !== undefined,
      lifelineError: dummy.lifelineError(),
      pid: dummy.pid,
      releasedAt,
    };
  } catch (error) {
    return {
      error: String(error),
      exitedAt: dummy.exitedAt(),
      exitedBeforeRelease,
      exitProven: dummy.exitedAt() !== undefined,
      lifelineError: dummy.lifelineError(),
      pid: dummy.pid,
      releasedAt,
    };
  }
}

// ---- Analysis of the snapshots ----

/** Nearest-rank median and the maximum. */
function spread(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return { max: sorted.at(-1), median: sorted[Math.ceil(sorted.length / 2) - 1] };
}

/**
 * The sampler's own cost over its steady window (first to last snapshot, so
 * Node's startup is excluded) and its achieved spacing. Its `ps` children's
 * CPU is not visible to it: their elapsed time is reported as wall duty, an
 * upper bound on their CPU, not a measurement of it.
 */
export function samplerOverhead(snapshots: readonly Snapshot[]) {
  const first = snapshots[0];
  const last = snapshots.at(-1);
  if (!(first && last && snapshots.length > 1)) {
    return { snapshots: snapshots.length };
  }
  const wallMs = last.tEnd - first.tEnd;
  const psWallMs = snapshots.map((snapshot) => snapshot.tEnd - snapshot.t);
  const share = (ms: number): number => Number((ms / wallMs).toFixed(4));
  return {
    psWallDuty: share(psWallMs.slice(1).reduce((total, ms) => total + ms, 0)),
    psWallMs: spread(psWallMs),
    samplerCpuShare: share(last.samplerCpuMs - first.samplerCpuMs),
    snapshots: snapshots.length,
    spacingMs: spread(
      snapshots.slice(1).map((snapshot, index) => snapshot.t - (snapshots[index]?.t ?? 0))
    ),
    wallSeconds: wallMs / 1000,
  };
}

/** Per-pid CPU between a process's first and last sighting (a lower bound). */
function cpuAdvanced(
  snapshots: readonly Snapshot[],
  rowsOf: (snapshot: Snapshot) => readonly ProcessRow[]
) {
  const byPid = new Map<
    number,
    { firstCpu: number; firstT: number; lastCpu: number; lastT: number; samples: number }
  >();
  for (const snapshot of snapshots) {
    for (const row of rowsOf(snapshot)) {
      const seen = byPid.get(row.pid);
      byPid.set(row.pid, {
        firstCpu: seen?.firstCpu ?? row.cpuSeconds,
        firstT: seen?.firstT ?? snapshot.t,
        lastCpu: row.cpuSeconds,
        lastT: snapshot.t,
        samples: (seen?.samples ?? 0) + 1,
      });
    }
  }
  return [...byPid].map(([pid, entry]) => ({
    cpuSecondsAdvanced: Number((entry.lastCpu - entry.firstCpu).toFixed(2)),
    fromT: entry.firstT,
    pid,
    samples: entry.samples,
    toT: entry.lastT,
  }));
}

/** Renderer pids come from Chromium itself (CDP `SystemInfo.getProcessInfo`), never from argv. */
export function rendererCpu(snapshots: readonly Snapshot[], rendererPids: ReadonlySet<number>) {
  return cpuAdvanced(snapshots, (snapshot) =>
    snapshot.runnerTree.filter((row) => rendererPids.has(row.pid))
  );
}

/** The guard's blind spot, kept visible: unknown hosts per snapshot and their CPU. */
export function blindSpot(snapshots: readonly Snapshot[]) {
  const perSnapshot = snapshots.map((snapshot) => ({
    t: snapshot.t,
    ...unknownSummary(snapshot.unknown),
  }));
  const range = (values: readonly number[]) =>
    values.length === 0 ? undefined : { max: Math.max(...values), min: Math.min(...values) };
  const advanced = cpuAdvanced(snapshots, (snapshot) => snapshot.unknown);
  return {
    count: range(perSnapshot.map((entry) => entry.count)),
    cpuSecondsAdvancedLowerBound: Number(
      advanced.reduce((total, entry) => total + entry.cpuSecondsAdvanced, 0).toFixed(2)
    ),
    note: BLIND_SPOT,
    pcpu: range(perSnapshot.map((entry) => entry.pcpu)),
    perSnapshot,
  };
}

/** `atStart`: the guard's own observation, so work that appeared mid-run is told apart. */
export function contentionSummary(
  snapshots: readonly Snapshot[],
  atStart: readonly ContentionMatch[]
) {
  const startPids = new Set(atStart.map((match) => match.pid));
  const contended = snapshots.filter((snapshot) => snapshot.contention.length > 0);
  const matches = new Map<number, ContentionMatch>();
  for (const snapshot of contended) {
    for (const match of snapshot.contention) {
      matches.set(match.pid, match);
    }
  }
  return {
    contended: contended.length > 0,
    contendedSnapshots: contended.length,
    firstT: contended[0]?.t,
    lastT: contended.at(-1)?.t,
    matches: [...matches.values()],
    midRun: [...matches.values()].filter((match) => !startPids.has(match.pid)),
  };
}

/** Identity only: never argv. */
export function describeMatch(match: ContentionMatch): string {
  return `  pid ${match.pid} ppid ${match.ppid} executable ${match.executable} workload ${match.workload}`;
}
