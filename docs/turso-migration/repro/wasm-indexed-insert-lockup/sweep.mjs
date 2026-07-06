// Headless-Chromium driver for the WASM indexed-insert lockup repro.
//
// Boots serve.mjs, then loads index.html in Playwright Chromium for a set of
// payload sizes and prints one JSON line per run. A run whose `tx` is
// "committed" passed; `tx: "ERROR: TIMEOUT: ..."` with `close: "ok"` is the
// lockup (the statement promise never settled but the engine wasn't
// CPU-wedged); `driverTimedOut: true` means even the page-level timeout
// didn't fire.
//
// Usage (from this directory, repo deps installed):
//   node sweep.mjs                 # the canonical pass/hang matrix on the installed version
//   node sweep.mjs one <bytes>     # a single size, e.g. `node sweep.mjs one 3000`
//   node sweep.mjs bisect          # fine sweep around the cliff
//
// Playwright is a devDependency of apps/web / packages already, so a bare
// `import 'playwright'` resolves from the repo. If it doesn't, run
// `pnpm --filter @brainstrike/web exec playwright install chromium` first.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4179;

// Data-dependent lockup: sizes are NOT a threshold. On @tursodatabase/
// database-wasm 0.6.1 (and 0.7.0-pre.17) the starred sizes hang; the others
// commit in milliseconds. Reproduced deterministically (3+x each).
const BASE_CONFIGS = [
  // [bytes, extraQuery, driverTimeoutMs]
  [2500, '', 60_000], // pass (control)
  [2900, '', 90_000], // HANG *
  [3000, '', 90_000], // HANG *
  [3100, '', 90_000], // HANG *
  [3200, '', 90_000], // HANG *
  [3400, '', 90_000], // pass
  [32_768, '', 120_000], // pass (gram key set is a SUPERSET of 3000's, yet passes)
  [1_048_576, '&timeout=90000', 150_000], // pass
];

const BISECT_CONFIGS = [
  2800, 2850, 2900, 2950, 3000, 3100, 3200, 3400, 3600, 4096,
].map((b) => [b, '', 90_000]);

async function drive(url, timeoutMs) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
  await page.goto(url);
  let timedOut = false;
  try {
    await page.waitForFunction(() => window.__done === true, undefined, { timeout: timeoutMs });
  } catch {
    timedOut = true;
  }
  const state = await page
    .evaluate(() => ({ result: window.__result, log: window.__log }))
    .catch(() => ({ result: { evalFailed: true }, log: [] }));
  await browser.close();
  return { ...state, driverTimedOut: timedOut, console: consoleLines.slice(-5) };
}

async function runConfigs(configs) {
  const server = spawn(process.execPath, ['serve.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await delay(700);
  try {
    for (const [bytes, extra, driverTimeout] of configs) {
      const url = `http://127.0.0.1:${PORT}/?bytes=${bytes}${extra}`;
      const startedAt = Date.now();
      const outcome = await drive(url, driverTimeout);
      const r = outcome.result ?? {};
      console.log(
        JSON.stringify({
          bytes,
          tx: r.tx ?? null,
          txMs: r.txMs ?? null,
          gramRows: r.gramRows ?? null,
          gramBatchesDone: r.gramBatchesDone ?? null,
          journalMode: r.journalMode ?? null,
          close: r.close ?? null,
          fatal: r.fatal ?? null,
          driverTimedOut: outcome.driverTimedOut,
          wallMs: Date.now() - startedAt,
        })
      );
    }
  } finally {
    server.kill('SIGKILL');
  }
}

const mode = process.argv[2] ?? 'base';
if (mode === 'base') {
  await runConfigs(BASE_CONFIGS);
} else if (mode === 'bisect') {
  await runConfigs(BISECT_CONFIGS);
} else if (mode === 'one') {
  const bytes = Number(process.argv[3] ?? '3000');
  await runConfigs([[bytes, '', 150_000]]);
} else {
  console.error(`unknown mode: ${mode} (use base | bisect | one <bytes>)`);
  process.exit(1);
}
