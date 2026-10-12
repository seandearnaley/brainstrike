#!/usr/bin/env node
/**
 * BST-1929 advisory perf lane for streamed assistant text. Not a required check:
 * the required gate is structural (committed-long-reply-parse and the recorded
 * publication tests); this lane reports wall-clock render cost.
 *
 * Builds the long-reply page with the shipped renderer config and React DOM's
 * profiling build, then, RUNS times on a fresh page throttled THROTTLE x over CDP,
 * streams the long reply and records the conversation's <Profiler> actualDuration
 * for 40 tokens at 10%, 50% and the end of it. Reports, per window, the median
 * and p95 per token (the summed duration of a token's commits) and per commit
 * (information only), and the median commits per token, then checks:
 *   - slope: per-token median at the end over per-token median at 10% (at most 1.5);
 *   - regression: each window's per-token median against
 *     streaming-perf.baseline.json (at most +30%).
 * Exits 1 when either check fails. --update-baseline rewrites the baseline from
 * this run and records the commit it measured.
 *
 * Usage: pnpm --filter @brainstrike/assistant-ui perf:streaming [--runs 5] [--throttle 4] [--update-baseline]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { preview } from 'vite';

const { values } = parseArgs({
  options: {
    runs: { default: '5', type: 'string' },
    throttle: { default: '4', type: 'string' },
    'update-baseline': { default: false, type: 'boolean' },
  },
});
const RUNS = Number(values.runs);
const THROTTLE = Number(values.throttle);
const SLOPE_LIMIT = 1.5;
const REGRESSION_LIMIT = 1.3;
const LABELS = ['10%', '50%', '100%'];
const PAGE_TIMEOUT_MS = 600_000;
const BASELINE = resolve(import.meta.dirname, 'streaming-perf.baseline.json');
const CONFIG = resolve(import.meta.dirname, 'vite.streaming-perf.config.mts');
const VITE = resolve(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js'
);

if (!(Number.isInteger(RUNS) && RUNS > 0 && THROTTLE >= 1)) {
  throw new Error(
    `--runs must be a positive integer and --throttle at least 1 (got ${RUNS}, ${THROTTLE}).`
  );
}

const percentile = (samples, rank) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((sorted.length * rank) / 100) - 1)];
};
const round = (value) => Math.round(value * 100) / 100;

async function measure(outDir) {
  const server = await preview({
    build: { outDir },
    configFile: CONFIG,
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  const browser = await chromium.launch({ headless: true });
  const runs = [];
  try {
    const { port } = server.httpServer.address();
    for (let run = 0; run < RUNS; run += 1) {
      const context = await browser.newContext({ viewport: { height: 800, width: 900 } });
      try {
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(
          () =>
            window.streamingPerfMeasurement !== undefined ||
            window.streamingPerfError !== undefined,
          undefined,
          { timeout: PAGE_TIMEOUT_MS }
        );
        const { error, measurement } = await page.evaluate(() => ({
          error: window.streamingPerfError,
          measurement: window.streamingPerfMeasurement,
        }));
        if (error || pageErrors.length > 0 || !measurement) {
          throw new Error(
            error ?? (pageErrors.join('\n') || 'The perf page produced no measurement.')
          );
        }
        runs.push(measurement);
        process.stderr.write(`run ${run + 1}/${RUNS} done\n`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.httpServer.close(resolveClose));
  }
  return runs;
}

const outDir = mkdtempSync(join(tmpdir(), 'brainstrike-streaming-perf-'));
try {
  // Vitest owns NODE_ENV=test elsewhere; this child build is the production CLI.
  const buildEnvironment = { ...process.env };
  buildEnvironment['NODE_ENV'] = 'production';
  execFileSync(
    process.execPath,
    [VITE, 'build', '--config', CONFIG, '--outDir', outDir, '--logLevel', 'warn'],
    { env: buildEnvironment, stdio: 'inherit' }
  );
  const runs = await measure(outDir);
  const windows = Object.fromEntries(
    LABELS.map((label) => {
      const commits = runs.flatMap((run) => run.windows[label].commitDurations);
      const tokens = runs.flatMap((run) => run.windows[label].tokenDurations);
      return [
        label,
        {
          commitMedian: round(percentile(commits, 50)),
          commitP95: round(percentile(commits, 95)),
          commitsPerToken: percentile(
            runs.flatMap((run) => run.windows[label].commitsPerToken),
            50
          ),
          tokenMedian: round(percentile(tokens, 50)),
          tokenP95: round(percentile(tokens, 95)),
          tokens: tokens.length,
        },
      ];
    })
  );
  const result = {
    react: runs[0].react,
    runs: RUNS,
    slope: round(windows['100%'].tokenMedian / windows['10%'].tokenMedian),
    throttle: THROTTLE,
    tokens: runs[0].tokens,
    windows,
  };

  if (values['update-baseline']) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ commit, recorded: new Date().toISOString(), ...result }, null, 2)}\n`
    );
    process.stdout.write(
      `${JSON.stringify(result, null, 2)}\nBaseline written to ${BASELINE} for ${commit}.\n`
    );
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    if (baseline.throttle !== THROTTLE) {
      throw new Error(
        `The baseline was recorded at ${baseline.throttle}x throttling, not ${THROTTLE}x.`
      );
    }
    const regressions = LABELS.filter(
      (label) => windows[label].tokenMedian > baseline.windows[label].tokenMedian * REGRESSION_LIMIT
    ).map(
      (label) =>
        `${label}: per-token median ${windows[label].tokenMedian} ms vs baseline ${baseline.windows[label].tokenMedian} ms`
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, baselineCommit: baseline.commit }, null, 2)}\n`
    );
    const failures = [
      ...(result.slope > SLOPE_LIMIT ? [`slope ${result.slope} exceeds ${SLOPE_LIMIT}`] : []),
      ...regressions.map(
        (line) => `regression over +${Math.round((REGRESSION_LIMIT - 1) * 100)}%: ${line}`
      ),
    ];
    for (const failure of failures) {
      process.stdout.write(`FAIL ${failure}\n`);
    }
    process.exitCode = failures.length > 0 ? 1 : 0;
  }
} finally {
  rmSync(outDir, { force: true, recursive: true });
}
