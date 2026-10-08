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
 *   pnpm exec node vite.committed-benchmark.config.mts --out <dir> [--runs <n>]
 *
 * Exit code: 0 when every run measured with full coverage and met the gate,
 * 1 when a run's p95 missed the gate, 2 when a run failed or its coverage was
 * incomplete (no gate verdict is drawn from such a run).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, loadavg, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import tailwindcss from '@tailwindcss/vite';
import { build, defineConfig, preview, version as viteVersion } from 'vite';

const PACKAGE_DIR = import.meta.dirname;
const BENCHMARK_DIR = resolve(PACKAGE_DIR, 'src/__tests__');
const ENTRY = 'committed-assistant-production-benchmark.html';
/** Gitignored: build output never lands in the source tree. */
const OUT_DIR = resolve(PACKAGE_DIR, 'node_modules/.committed-benchmark/dist');
const VIEWPORT = { height: 800, width: 900 } as const;
const GATE_MS = 8;
const RUN_TIMEOUT_MS = 20 * 60_000;
const SOURCE_FILES = [
  'vite.committed-benchmark.config.mts',
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

interface Args {
  readonly out: string;
  readonly runs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const out = value('--out');
  const runs = Number(value('--runs') ?? '1');
  if (!out) {
    throw new Error('Pass --out <dir> for the raw results.');
  }
  if (!(Number.isInteger(runs) && runs > 0)) {
    throw new Error('--runs must be a positive integer.');
  }
  return { out: resolve(out), runs };
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: PACKAGE_DIR, encoding: 'utf8' }).trim();

async function sourceIdentity() {
  const files: Record<string, string> = {};
  for (const file of SOURCE_FILES) {
    files[file] = sha256(await readFile(resolve(PACKAGE_DIR, file)));
  }
  return {
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', '.') !== '',
    files,
    tree: git('rev-parse', 'HEAD^{tree}'),
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

interface PageState {
  readonly error?: string;
  readonly result?: {
    readonly summary: Record<
      string,
      { p50: number; p95: number; max: number } & Record<string, number>
    >;
  };
  readonly status: 'done' | 'failed' | 'running';
}

async function measureRuns(url: string, runs: number) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results: unknown[] = [];
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

type Verdict = 'failed' | 'incomplete-coverage' | 'missed' | 'met';

function verdictOf(state: PageState | undefined): { line: string; verdict: Verdict } {
  if (state?.status !== 'done' || !state.result) {
    return { line: `failed: ${state?.error ?? 'no result'}`, verdict: 'failed' };
  }
  const parts: string[] = [];
  let complete = true;
  for (const [key, row] of Object.entries(state.result.summary)) {
    complete &&= row['commitsCovered'] === row['commitsTotal'];
    parts.push(
      `${key}: p50 ${row.p50.toFixed(2)} p95 ${row.p95.toFixed(2)} max ${row.max.toFixed(2)} ms, commits covered ${row['commitsCovered']}/${row['commitsTotal']}`
    );
  }
  const gate = state.result.summary['unwrapped text-delta'];
  if (!(complete && gate)) {
    return { line: parts.join('\n  '), verdict: 'incomplete-coverage' };
  }
  return { line: parts.join('\n  '), verdict: gate.p95 <= GATE_MS ? 'met' : 'missed' };
}

async function runBenchmark(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const source = await sourceIdentity();
  await build({ configFile: import.meta.filename, mode: 'production' });
  const bundle = await bundleIdentity();
  const server = await preview({ configFile: import.meta.filename, mode: 'production' });
  const base = server.resolvedUrls?.local[0];
  if (!base) {
    throw new Error('vite preview did not report a local URL.');
  }
  try {
    const measured = await measureRuns(new URL(ENTRY, base).href, args.runs);
    const require = createRequire(import.meta.url);
    const report = {
      build: { ...bundle, mode: 'production', vite: viteVersion },
      gate: { metric: 'unwrapped text-delta reactMs p95', thresholdMs: GATE_MS },
      runs: measured.results,
      runtime: {
        browser: measured.browserVersion,
        cpu: cpus()[0]?.model,
        cpus: cpus().length,
        node: process.versions.node,
        os: release(),
        playwright: (require('playwright/package.json') as { version: string }).version,
        react: (require('react/package.json') as { version: string }).version,
        reactDom: (require('react-dom/package.json') as { version: string }).version,
      },
      source,
    };
    await mkdir(args.out, { recursive: true });
    const file = join(
      args.out,
      `committed-benchmark-${new Date().toISOString().replaceAll(':', '-')}.json`
    );
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    const verdicts = measured.results.map((run) => verdictOf((run as { state?: PageState }).state));
    const lines = verdicts.map(
      ({ line, verdict }, index) => `run ${index + 1} [${verdict}]\n  ${line}`
    );
    process.stdout.write(
      `${lines.join('\n')}\nbundle ${bundle.digest}\nsource ${source.commit} tree ${source.tree} dirty=${source.dirty}\nraw ${file}\n`
    );
    if (verdicts.some(({ verdict }) => verdict === 'failed' || verdict === 'incomplete-coverage')) {
      return 2;
    }
    return verdicts.every(({ verdict }) => verdict === 'met') ? 0 : 1;
  } finally {
    await server.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runBenchmark();
}
