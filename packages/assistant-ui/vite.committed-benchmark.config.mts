/**
 * BST-1929 production-React benchmark: build config and runner in one file.
 *
 * As a Vite config it builds `src/__tests__/committed-assistant-production-benchmark.html`
 * in production mode (React's production build, minified) with the same
 * workspace source aliases, dedupe and CSS pipeline as the package's browser
 * test lane. It changes no shared config.
 *
 * Run directly, it builds, hashes the built bundle, serves it with `vite
 * preview`, drives it in Playwright's Chromium at the suite's 900×800 viewport,
 * and writes the raw samples plus source, runtime and build identities:
 *
 *   cd packages/assistant-ui
 *   pnpm exec node vite.committed-benchmark.config.mts --out <dir> [--runs <n>] [--mode <mode>]
 *
 * Modes:
 * - `qualification` (the default) measures.
 * - `controls` runs only the in-page harness controls. Add `--inject-contention`
 *   to start a harmless dummy whose argv matches a lint command mid-run (the
 *   contention control).
 * - `negative-control` also injects one uncaught page error, which must fail
 *   the verdict.
 * - `source` prints the worktree identity only.
 * - `guard` only evaluates the contention guard; nothing is built or measured.
 * - `sampler-control` is the sampler's positive control. It keeps a blank
 *   page's renderer (never the measured page) busy for 3 s; the sampler must
 *   see that renderer's CPU time advance by at least 1 s.
 *
 * `qualification` (and `guard`) refuse to start, before building, when other
 * build, lint or test work is observed. The control modes measure no gate:
 * they record what the guard saw and proceed. Every page run starts the
 * out-of-page host sampler (`committed-benchmark-sampler.mts`) at the lowest
 * priority, and stops and joins it before reporting. Contention seen by the
 * sampler marks the run contended, and work absent at the guard check is
 * reported as `midRun`. The measured page and its instrumentation are
 * unchanged.
 *
 * Exit codes:
 * - 0: every run measured with full coverage, no captured execution error, no
 *   contention and a met gate.
 * - 1: a run's p95 missed the gate.
 * - 2: a run failed, captured an execution error, had incomplete coverage, the
 *   sampler failed, or the worktree is not exactly the committed source. No
 *   gate verdict is drawn.
 * - 3: the guard refused to start because other build, lint or test work was
 *   running.
 * - 4: such work appeared mid-run, so the run is contended. Its verdict is
 *   reported but not counted, nothing is retried and no trial is discarded.
 *
 * The control modes exit 0 only when they observe what they must; the
 * contention control exits 4.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, getPriority, loadavg, release, setPriority } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import tailwindcss from '@tailwindcss/vite';
import { build, defineConfig, preview, version as viteVersion } from 'vite';
import {
  type ContentionMatch,
  CPU_TIME_RESOLUTION_SECONDS,
  contentionIn,
  readProcesses,
  SAMPLE_INTERVAL_MS,
} from './committed-benchmark-sampler.mts';

const PACKAGE_DIR = import.meta.dirname;
const BENCHMARK_DIR = resolve(PACKAGE_DIR, 'src/__tests__');
const ENTRY = 'committed-assistant-production-benchmark.html';
/** Gitignored: build output never lands in the source tree. */
const OUT_DIR = resolve(PACKAGE_DIR, 'node_modules/.committed-benchmark/dist');
const SAMPLER_FILE = resolve(PACKAGE_DIR, 'committed-benchmark-sampler.mts');
const VIEWPORT = { height: 800, width: 900 } as const;
const GATE_MS = 8;
const RUN_TIMEOUT_MS = 20 * 60_000;
const SOURCE_FILES = [
  'vite.committed-benchmark.config.mts',
  'committed-benchmark-sampler.mts',
  'src/__tests__/committed-assistant-production-benchmark.html',
  'src/__tests__/committed-assistant-production-benchmark.tsx',
  'src/__tests__/fixtures/committed-approved-host-run.json',
  'src/__tests__/fixtures/child-continuation-native-wire.json',
] as const;

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    manifest: true,
    minify: true,
    outDir: OUT_DIR,
    rolldownOptions: { input: resolve(BENCHMARK_DIR, ENTRY) },
    sourcemap: false,
  },
  // Pinned explicitly, not inherited from the environment.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  logLevel: 'warn',
  mode: 'production',
  plugins: [tailwindcss()],
  preview: { host: '127.0.0.1', port: 0, strictPort: false },
  publicDir: false,
  resolve: {
    alias: [
      // The same order as vitest.config.mts: exact ui overrides, then the registry.
      { find: /^@brainstrike\/ui$/, replacement: resolve(PACKAGE_DIR, '../ui/src/index.ts') },
      {
        find: /^@brainstrike\/ui\/globals\.css$/,
        replacement: resolve(PACKAGE_DIR, '../ui/src/globals.css'),
      },
      ...workspaceSrcAliases(resolve(PACKAGE_DIR, '..')),
    ],
    dedupe: ['react', 'react-dom'],
  },
  root: BENCHMARK_DIR,
});

// ---- Runner (only when this file is executed directly) ----

type Mode =
  | 'controls'
  | 'guard'
  | 'negative-control'
  | 'qualification'
  | 'sampler-control'
  | 'source';
const MODES: readonly Mode[] = [
  'controls',
  'guard',
  'negative-control',
  'qualification',
  'sampler-control',
  'source',
];
/** The sampler positive control keeps a blank page's renderer busy this long. */
const SAMPLER_CONTROL_BUSY_MS = 3000;
/** Must match the page's injected error (committed-assistant-production-benchmark.tsx). */
const NEGATIVE_CONTROL_ERROR = 'BST-1929 negative control: injected execution error';
const MIDRUN_CONTROL_ARGV = ['biome', 'check', '--bst1929-midrun-contention-control'];

interface Args {
  readonly injectContention: boolean;
  readonly mode: Mode;
  readonly out: string;
  readonly runs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const mode = (value('--mode') ?? 'qualification') as Mode;
  const out = value('--out');
  const runs = Number(value('--runs') ?? '1');
  const injectContention = argv.includes('--inject-contention');
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join(', ')}.`);
  }
  if (!out) {
    throw new Error('Pass --out <dir> for the raw results.');
  }
  if (!(Number.isInteger(runs) && runs > 0)) {
    throw new Error('--runs must be a positive integer.');
  }
  if (injectContention && mode !== 'controls') {
    throw new Error('--inject-contention is a control and only runs with --mode controls.');
  }
  return {
    injectContention,
    mode,
    out: resolve(out),
    runs: mode === 'qualification' ? runs : 1,
  };
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: PACKAGE_DIR, encoding: 'utf8' }).trim();

async function sourceIdentity() {
  const files: Record<string, string> = {};
  for (const file of SOURCE_FILES) {
    files[file] = sha256(await readFile(resolve(PACKAGE_DIR, file)));
  }
  // The whole worktree, not just this package: the build resolves every
  // `@brainstrike/*` import to workspace source. Porcelain lines keep their
  // leading status column, so only the trailing newline is trimmed.
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  }).trimEnd();
  const dirtyPaths = status === '' ? [] : status.split('\n');
  return {
    commit: git('rev-parse', 'HEAD'),
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
    /** True only when the entire worktree has no change against `commit`. */
    exact: dirtyPaths.length === 0,
    files,
    tree: git('rev-parse', 'HEAD^{tree}'),
    worktree: git('rev-parse', '--show-toplevel'),
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]
    )
  );
  return nested.flat().sort();
}

async function bundleIdentity() {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const file of await listFiles(OUT_DIR)) {
    const data = await readFile(file);
    files[relative(OUT_DIR, file)] = { bytes: data.byteLength, sha256: sha256(data) };
  }
  const digest = sha256(
    Object.entries(files)
      .map(([file, { sha256: hash }]) => `${file}:${hash}`)
      .join('\n')
  );
  return { digest, files };
}

// ---- Out-of-page host sampler: start at the lowest priority, stop and join ----

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function startSampler(out: string) {
  const child = spawn(process.execPath, [SAMPLER_FILE, out, String(process.pid)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const { pid } = child;
  if (pid === undefined) {
    throw new Error('The host sampler did not start.');
  }
  setPriority(pid, 19);
  // Sampling must be under way before anything it is meant to observe.
  for (let waited = 0; ; waited += 50) {
    const text = await readFile(out, 'utf8').catch(() => '');
    if (text.includes('\n')) {
      break;
    }
    if (waited > 10_000 || child.exitCode !== null) {
      throw new Error('The host sampler produced no snapshot.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, pid, priority: getPriority(pid), startedAt: Date.now() };
}

type Sampler = Awaited<ReturnType<typeof startSampler>>;

/** SIGTERM, then wait for the exit event and confirm the pid is gone (the physical join). */
async function joinSampler({ child, pid }: Sampler) {
  const exited =
    child.exitCode === null && child.signalCode === null
      ? once(child, 'exit')
      : Promise.resolve([child.exitCode, child.signalCode]);
  child.kill('SIGTERM');
  const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
  return { code, joinedAt: Date.now(), pid, signal, stillRunning: isAlive(pid) };
}

interface Snapshot {
  readonly chromium: readonly {
    readonly cpuSeconds: number;
    readonly pid: number;
    readonly type: string;
  }[];
  readonly contention: readonly ContentionMatch[];
  readonly loadavg: readonly number[];
  readonly samplerCpuMs: number;
  readonly t: number;
  readonly tEnd: number;
}

/** Nearest-rank median and the maximum. */
function spread(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return { max: sorted.at(-1), median: sorted[Math.ceil(sorted.length / 2) - 1] };
}

/**
 * The sampler's own cost over its steady window (first to last snapshot, so
 * Node's startup is excluded) and its achieved spacing. Its `ps` children's
 * CPU is not visible to it, so their wall time is reported as an upper bound.
 */
function samplerOverhead(snapshots: readonly Snapshot[]) {
  const first = snapshots[0];
  const last = snapshots.at(-1);
  if (!(first && last && snapshots.length > 1)) {
    return { snapshots: snapshots.length };
  }
  const wallMs = last.tEnd - first.tEnd;
  const psWallMs = snapshots.map((snapshot) => snapshot.tEnd - snapshot.t);
  const share = (ms: number): number => Number((ms / wallMs).toFixed(4));
  return {
    psWallMs: spread(psWallMs),
    psWallShareUpperBound: share(psWallMs.slice(1).reduce((total, ms) => total + ms, 0)),
    samplerCpuShare: share(last.samplerCpuMs - first.samplerCpuMs),
    snapshots: snapshots.length,
    spacingMs: spread(
      snapshots.slice(1).map((snapshot, index) => snapshot.t - (snapshots[index]?.t ?? 0))
    ),
    wallSeconds: wallMs / 1000,
  };
}

/** Cumulative CPU of each renderer across the run; proves the sampler sees it advance. */
function rendererCpu(snapshots: readonly Snapshot[]) {
  const byPid = new Map<
    number,
    { first: Snapshot; firstCpu: number; last: Snapshot; lastCpu: number; samples: number }
  >();
  for (const snapshot of snapshots) {
    for (const process_ of snapshot.chromium.filter((entry) => entry.type === 'renderer')) {
      const seen = byPid.get(process_.pid);
      byPid.set(process_.pid, {
        first: seen?.first ?? snapshot,
        firstCpu: seen?.firstCpu ?? process_.cpuSeconds,
        last: snapshot,
        lastCpu: process_.cpuSeconds,
        samples: (seen?.samples ?? 0) + 1,
      });
    }
  }
  return [...byPid].map(([pid, entry]) => ({
    cpuSecondsAdvanced: Number((entry.lastCpu - entry.firstCpu).toFixed(2)),
    fromT: entry.first.t,
    pid,
    samples: entry.samples,
    toT: entry.last.t,
  }));
}

/** `atStart`: the guard's own observation, so work that appeared mid-run is told apart. */
function contentionSummary(snapshots: readonly Snapshot[], atStart: readonly ContentionMatch[]) {
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
function describeMatch(match: ContentionMatch): string {
  return `  pid ${match.pid} ${match.pattern} executable ${match.executable} worktree ${match.worktree ?? '-'}`;
}

/** A harmless, idle dummy whose argv reads like a lint run; reparented away from the runner. */
function startContentionDummy(): number {
  const launcher = `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)',...${JSON.stringify(MIDRUN_CONTROL_ARGV)}],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(String(c.pid));`;
  return Number(execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8' }));
}

// ---- Page runs and verdicts ----

interface PageState {
  readonly error?: string;
  readonly result?: {
    readonly summary?: Record<
      string,
      { p50: number; p95: number; max: number } & Record<string, number>
    >;
  };
  readonly status: 'done' | 'failed' | 'running';
}

interface RunRecord {
  readonly loadavg: number[];
  readonly pageErrors: string[];
  readonly startedAt: string;
  readonly state: PageState;
}

async function measureRuns(url: string, runs: number) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results: RunRecord[] = [];
  try {
    for (let index = 0; index < runs; index += 1) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          pageErrors.push(message.text());
        }
      });
      // The page pushes its final state through a CDP binding. Polling from the
      // runner (waitForFunction) would run its own animation frames or timers in
      // the measured page and be timed as page work.
      const finished = Promise.withResolvers<PageState>();
      await page.exposeFunction('__committedBenchmarkReport', (json: string) => {
        const state = JSON.parse(json) as PageState;
        if (state.status !== 'running') {
          finished.resolve(state);
        }
      });
      const timeout = setTimeout(
        () => finished.reject(new Error('The benchmark page did not finish in time.')),
        RUN_TIMEOUT_MS
      );
      const startedAt = new Date().toISOString();
      await page.goto(url);
      const state = await finished.promise.finally(() => clearTimeout(timeout));
      results.push({ loadavg: loadavg(), pageErrors, startedAt, state });
      await context.close();
    }
    return { browserVersion: browser.version(), results };
  } finally {
    await browser.close();
  }
}

type Verdict = 'controls-passed' | 'failed' | 'incomplete-coverage' | 'met' | 'missed';
interface Judgement {
  readonly line: string;
  readonly reason: 'controls-only' | 'coverage' | 'execution-error' | 'gate' | 'page-failed';
  readonly verdict: Verdict;
}

function verdictOf(run: RunRecord): Judgement {
  const { state } = run;
  // Any captured execution error fails qualification; the details stay in the raw run.
  if (run.pageErrors.length > 0) {
    return {
      line: `failed: ${run.pageErrors.length} captured execution error(s): ${run.pageErrors.join(' | ')}`,
      reason: 'execution-error',
      verdict: 'failed',
    };
  }
  if (state.status !== 'done' || !state.result) {
    return {
      line: `failed: ${state.error ?? 'no result'}`,
      reason: 'page-failed',
      verdict: 'failed',
    };
  }
  const { summary } = state.result;
  if (!summary) {
    return { line: 'controls passed', reason: 'controls-only', verdict: 'controls-passed' };
  }
  const parts: string[] = [];
  let complete = true;
  for (const [key, row] of Object.entries(summary)) {
    complete &&= row['commitsCovered'] === row['commitsTotal'];
    parts.push(
      `${key}: p50 ${row.p50.toFixed(2)} p95 ${row.p95.toFixed(2)} max ${row.max.toFixed(2)} ms, commits covered ${row['commitsCovered']}/${row['commitsTotal']}`
    );
  }
  const gate = summary['unwrapped text-delta'];
  if (!(complete && gate)) {
    return { line: parts.join('\n  '), reason: 'coverage', verdict: 'incomplete-coverage' };
  }
  return {
    line: parts.join('\n  '),
    reason: 'gate',
    verdict: gate.p95 <= GATE_MS ? 'met' : 'missed',
  };
}

/** What each mode must observe; anything else is a harness failure (exit 2). */
function exitCodeOf(
  mode: Mode,
  runs: readonly RunRecord[],
  judgements: readonly Judgement[]
): number {
  if (mode === 'controls') {
    return judgements.every(({ verdict }) => verdict === 'controls-passed') ? 0 : 2;
  }
  if (mode === 'negative-control') {
    const caught = runs.every((run, index) => {
      const judgement = judgements[index];
      return (
        judgement?.verdict === 'failed' &&
        judgement.reason === 'execution-error' &&
        run.pageErrors.some((error) => error.includes(NEGATIVE_CONTROL_ERROR))
      );
    });
    return caught ? 0 : 2;
  }
  if (judgements.some(({ verdict }) => verdict !== 'met' && verdict !== 'missed')) {
    return 2;
  }
  return judgements.every(({ verdict }) => verdict === 'met') ? 0 : 1;
}

function stamp(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

async function writeReport(out: string, name: string, report: unknown): Promise<string> {
  await mkdir(out, { recursive: true });
  const file = join(out, `committed-benchmark-${name}-${stamp()}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/**
 * Guard: a measurement (`qualification`) refuses to start when other build,
 * lint or test work is observed, before it builds anything; so does `guard`,
 * which only evaluates it. The control modes measure no gate: they record what
 * the guard saw and still mark any contention, but proceed.
 */
async function guardOrRefuse(args: Args, source: Awaited<ReturnType<typeof sourceIdentity>>) {
  const guard = {
    checkedAt: Date.now(),
    matches: contentionIn(await readProcesses(), process.pid),
  };
  const enforced = args.mode === 'qualification' || args.mode === 'guard';
  if (guard.matches.length === 0 || !enforced) {
    if (args.mode === 'guard') {
      process.stdout.write('mode guard exit 0 (no other build/lint/test work observed)\n');
    }
    return { guard, refused: false } as const;
  }
  const file = await writeReport(args.out, `${args.mode}-refused`, {
    guard: { ...guard, refused: true },
    mode: args.mode,
    source,
  });
  process.stdout.write(
    `mode ${args.mode} exit 3 (refused: other build/lint/test work is running)\n${guard.matches.map(describeMatch).join('\n')}\nraw ${file}\n`
  );
  return { guard, refused: true } as const;
}

async function buildAndMeasure(args: Args) {
  await build({ configFile: import.meta.filename, mode: 'production' });
  const bundle = await bundleIdentity();
  const server = await preview({ configFile: import.meta.filename, mode: 'production' });
  try {
    const base = server.resolvedUrls?.local[0];
    if (!base) {
      throw new Error('vite preview did not report a local URL.');
    }
    const hash = args.mode === 'qualification' ? '' : `#${args.mode}`;
    return {
      bundle,
      measured: await measureRuns(`${new URL(ENTRY, base).href}${hash}`, args.runs),
    };
  } finally {
    await server.close();
  }
}

/**
 * Sampler positive control: the same Playwright Chromium, a blank page (never
 * the measured page) whose renderer is kept busy, so its CPU time must advance.
 */
async function busyRendererControl() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto('about:blank');
    const busyMs = await page.evaluate((duration) => {
      const start = performance.now();
      while (performance.now() - start < duration) {
        // Busy on purpose: the renderer's CPU time must advance.
      }
      return performance.now() - start;
    }, SAMPLER_CONTROL_BUSY_MS);
    await context.close();
    return { browserVersion: browser.version(), busyMs };
  } finally {
    await browser.close();
  }
}

/** The sampler runs from before the build until after the browser closes, then is joined. */
async function sampledRun(args: Args) {
  await mkdir(args.out, { recursive: true });
  const samplesFile = join(args.out, `host-samples-${args.mode}-${stamp()}.jsonl`);
  const sampler = await startSampler(samplesFile);
  let dummy: number | undefined;
  let outcome: Awaited<ReturnType<typeof buildAndMeasure>> | undefined;
  let busy: Awaited<ReturnType<typeof busyRendererControl>> | undefined;
  let failure: unknown;
  try {
    dummy = args.injectContention ? startContentionDummy() : undefined;
    if (args.mode === 'sampler-control') {
      busy = await busyRendererControl();
    } else {
      outcome = await buildAndMeasure(args);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (dummy !== undefined && isAlive(dummy)) {
      process.kill(dummy, 'SIGTERM');
    }
  }
  const joined = await joinSampler(sampler);
  const snapshots = (await readFile(samplesFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Snapshot);
  return { busy, dummy, failure, joined, outcome, sampler, samplesFile, snapshots };
}

type SampledRun = Awaited<ReturnType<typeof sampledRun>>;

function exitCodeFor(
  args: Args,
  run: SampledRun,
  judgements: readonly Judgement[],
  qualified: boolean,
  samplerOk: boolean,
  contended: boolean
): number {
  if (args.mode === 'sampler-control') {
    return run.failure === undefined && samplerOk ? 0 : 2;
  }
  const measured = run.outcome?.measured;
  const measuredCode =
    run.failure === undefined && measured ? exitCodeOf(args.mode, measured.results, judgements) : 2;
  if (!(qualified && samplerOk) || measuredCode === 2) {
    return 2;
  }
  return contended ? 4 : measuredCode;
}

/**
 * The sampler must always be joined after a clean exit: a crash would leave
 * the rest of the run unsampled. Where a renderer runs long enough to be
 * sampled it must also be seen advancing; the short control pages only have
 * to be joined.
 */
function samplerOkFor(
  mode: Mode,
  run: SampledRun,
  renderers: readonly { readonly cpuSecondsAdvanced: number }[]
): boolean {
  const minimumAdvance = mode === 'sampler-control' ? 1 : mode === 'qualification' ? 0.01 : 0;
  return (
    run.joined.code === 0 &&
    !run.joined.stillRunning &&
    (minimumAdvance === 0 ||
      renderers.some((renderer) => renderer.cpuSecondsAdvanced >= minimumAdvance))
  );
}

async function runBenchmark(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const source = await sourceIdentity();
  if (args.mode === 'source') {
    process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
    return source.exact ? 0 : 2;
  }
  const { guard, refused } = await guardOrRefuse(args, source);
  if (refused) {
    return 3;
  }
  if (args.mode === 'guard') {
    return 0;
  }
  const run = await sampledRun(args);
  const measured = run.outcome?.measured;
  const contention = contentionSummary(run.snapshots, guard.matches);
  const renderers = rendererCpu(run.snapshots);
  const overhead = samplerOverhead(run.snapshots);
  const samplerOk = samplerOkFor(args.mode, run, renderers);
  const judgements = measured?.results.map(verdictOf) ?? [];
  const qualified = args.mode !== 'qualification' || source.exact;
  const code = exitCodeFor(args, run, judgements, qualified, samplerOk, contention.contended);
  const require = createRequire(import.meta.url);
  const file = await writeReport(args.out, args.mode, {
    build: run.outcome
      ? { ...run.outcome.bundle, mode: 'production', vite: viteVersion }
      : undefined,
    busyControl: run.busy,
    exitCode: code,
    failure: run.failure === undefined ? undefined : String(run.failure),
    gate: { metric: 'unwrapped text-delta reactMs p95', thresholdMs: GATE_MS },
    guard: { ...guard, refused: false },
    judgements,
    mode: args.mode,
    runs: measured?.results ?? [],
    runtime: {
      browser: measured?.browserVersion ?? run.busy?.browserVersion,
      cpu: cpus()[0]?.model,
      cpus: cpus().length,
      node: process.versions.node,
      os: release(),
      playwright: (require('playwright/package.json') as { version: string }).version,
      react: (require('react/package.json') as { version: string }).version,
      reactDom: (require('react-dom/package.json') as { version: string }).version,
    },
    sampler: {
      contention,
      cpuTimeResolutionSeconds: CPU_TIME_RESOLUTION_SECONDS,
      dummy:
        run.dummy === undefined ? undefined : { pid: run.dummy, stillRunning: isAlive(run.dummy) },
      file: run.samplesFile,
      intervalMs: SAMPLE_INTERVAL_MS,
      join: run.joined,
      ok: samplerOk,
      overhead,
      pid: run.sampler.pid,
      priority: run.sampler.priority,
      renderers,
      snapshots: run.snapshots,
      startedAt: run.sampler.startedAt,
    },
    source,
  });
  process.stdout.write(
    [
      `mode ${args.mode} exit ${code}${qualified ? '' : ' (source is not exactly committed)'}${contention.contended ? ' CONTENDED' : ''}`,
      ...judgements.map(
        ({ line, reason, verdict }, index) =>
          `run ${index + 1} [${verdict}, ${reason}] errors ${measured?.results[index]?.pageErrors.length}\n  ${line}`
      ),
      `sampler pid ${run.sampler.pid} priority ${run.sampler.priority} snapshots ${run.snapshots.length} joined code=${run.joined.code} signal=${run.joined.signal} stillRunning=${run.joined.stillRunning}`,
      `sampler overhead ${JSON.stringify(overhead)} interval ${SAMPLE_INTERVAL_MS} ms, cpu time resolution ${CPU_TIME_RESOLUTION_SECONDS} s`,
      `renderers ${JSON.stringify(renderers)}`,
      `busy control ${run.busy ? `${run.busy.busyMs.toFixed(0)} ms` : 'not run'}`,
      `contention atStart ${guard.matches.length}, seen in ${contention.contendedSnapshots}/${run.snapshots.length} snapshots, midRun ${contention.midRun.length}${contention.midRun.map((match) => `\n  midRun${describeMatch(match)}`).join('')}`,
      `bundle ${run.outcome?.bundle.digest}`,
      `source ${source.commit} tree ${source.tree} exact=${source.exact} dirty ${source.dirtyPaths.length}`,
      `raw ${file}`,
      run.failure === undefined ? '' : `failure ${String(run.failure)}`,
    ].join('\n')
  );
  return code;
}

if (import.meta.main) {
  process.exitCode = await runBenchmark();
}
