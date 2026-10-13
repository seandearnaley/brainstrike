// BST-1940 spike driver: the production build of the harness, served by `vite preview`, in the
// provisioned Chrome for Testing (apps/web/config/web-chromium.mjs), each scenario in a disposable
// persistent profile under the scratchpad. Usage: node bench/run.mjs <lifecycle|perf> <out.json> [runs]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { getWebChromiumExecutablePath } from '../../../apps/web/config/web-chromium.mjs';

const [suite, out, runsArg] = process.argv.slice(2);
const profileRoot = process.env.SPIKE_PROFILE_ROOT;
if (!(suite && out && profileRoot)) {
  throw new Error(
    'usage: SPIKE_PROFILE_ROOT=<dir> node bench/run.mjs <lifecycle|perf> <out.json> [runs]'
  );
}
const executablePath = getWebChromiumExecutablePath(
  join(homedir(), '.cache/brainstrike-web-chromium'),
  process.platform,
  process.arch
);
const origin = 'http://127.0.0.1:4179/';
mkdirSync(profileRoot, { recursive: true });

const server = spawn('node_modules/.bin/vite', ['preview'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) =>
    String(chunk).includes('4179') ? resolve(undefined) : undefined
  );
  server.on('exit', (code) => reject(new Error(`vite preview exited ${code}`)));
});

const freshProfile = (name) => mkdtempSync(join(profileRoot, `${name}-`));

async function launch(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await openPage(page);
  return { context, page };
}

async function openPage(page) {
  await page.goto(origin);
  await page.waitForFunction(() => document.title === 'bst1940-spike ready');
}

const start = (page, key, engine) =>
  page.evaluate(([k, e]) => globalThis.spike.start(k, e), [key, engine]);
const call = (page, key, command, input) =>
  page.evaluate(([k, c, i]) => globalThis.spike.call(k, c, i), [key, command, input]);
const opfs = (page, marker) => page.evaluate((m) => globalThis.spike.opfs(m), marker);

/** SIGKILL the browser process that owns this profile (no shutdown, no flush hooks). */
function killBrowser(profile) {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  const main = lines.find(
    (line) => line.includes(`--user-data-dir=${profile}`) && !line.includes('--type=')
  );
  if (!main) {
    throw new Error(`no browser process for ${profile}`);
  }
  process.kill(Number(main.trim().split(/\s+/)[0]), 'SIGKILL');
}

async function closeKilled(context) {
  await context.close().catch(() => undefined);
}

const browserVersion = async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const version = browser.version();
  await browser.close();
  return version;
};

const identity = {
  browser: await browserVersion(),
  executablePath,
  loadAtStart: loadavg(),
  node: process.version,
  startedAt: new Date().toISOString(),
};

async function lifecycle() {
  const results = {};
  const profile = freshProfile('lifecycle');
  let { context, page } = await launch(profile);

  // 1. Cold open on an empty origin: lock, VFS, desktop schema, PRAGMAs.
  await start(page, 'a', 'sqlite');
  results.coldOpen = await call(page, 'a', 'open', { wait: true });
  results.firstRun = await call(page, 'a', 'appendRun', { seed: 1, steps: 3, threadId: 't1' });
  results.firstIndex = await call(page, 'a', 'indexChunks', {
    chunksPerFile: 10,
    fileOffset: 0,
    files: 10,
    linesPerChunk: 10,
    seed: 7,
  });
  const before = await call(page, 'a', 'counts');
  results.beforeReload = before;

  // 2. Reload: same data, integrity ok, crc/seq verified.
  await openPage(page);
  await start(page, 'a', 'sqlite');
  results.reloadOpen = await call(page, 'a', 'open', { wait: true });
  results.afterReload = {
    counts: await call(page, 'a', 'counts'),
    verify: await call(page, 'a', 'verify'),
  };

  // 3. Delete a thread with a unique marker, then reload: no resurrection; physical bytes after checkpoint.
  const marker = `BST1940-MARKER-${Date.now()}`;
  await call(page, 'a', 'appendMarker', { marker, rows: 20, threadId: 'doomed' });
  await call(page, 'a', 'checkpoint');
  await call(page, 'a', 'deleteThread', { threadId: 'doomed' });
  await openPage(page);
  await start(page, 'a', 'sqlite');
  await call(page, 'a', 'open', { wait: true });
  results.deleteThenReload = await call(page, 'a', 'counts');
  await call(page, 'a', 'checkpoint');
  await call(page, 'a', 'retire');
  results.markerScanAfterCheckpoint = (await opfs(page, marker)).entries.filter(
    (entry) => entry.marker
  );

  // 4. Second tab: a non-waiting open is refused; a waiting open gets the pool only after the leader retires.
  await start(page, 'a', 'sqlite');
  await call(page, 'a', 'open', { wait: true });
  const tab = await context.newPage();
  await openPage(tab);
  await start(tab, 'b', 'sqlite');
  results.secondTabNoWait = await call(tab, 'b', 'open', { wait: false });
  // A writer that ignores the lock: what does 3.53.4 do to the leader's pool?
  await start(tab, 'rogue', 'sqlite');
  results.secondTabUnlocked = await call(tab, 'rogue', 'openUnlocked');
  results.leaderAfterRogue = {
    counts: await call(page, 'a', 'counts'),
    verify: await call(page, 'a', 'verify'),
  };
  await tab.evaluate(() => globalThis.spike.terminate('rogue'));
  const waiting = call(tab, 'b', 'open', { wait: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await call(page, 'a', 'appendRun', { seed: 2, steps: 2, threadId: 't1' });
  await call(page, 'a', 'retire');
  results.secondTabTakeover = await waiting;
  results.secondTabSees = await call(tab, 'b', 'counts');
  await call(tab, 'b', 'retire');
  await tab.close();

  // 5. Crash mid-write (SIGKILL the browser), five times, with a committed delete before each.
  results.crashes = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await start(page, 'a', 'sqlite');
    await call(page, 'a', 'open', { wait: true });
    await call(page, 'a', 'appendMarker', {
      marker: `gone-${attempt}`,
      rows: 5,
      threadId: `gone-${attempt}`,
    });
    await call(page, 'a', 'deleteThread', { threadId: `gone-${attempt}` });
    await call(page, 'a', 'writeForever', { threadId: 'crash' });
    await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 400));
    killBrowser(profile);
    await closeKilled(context);
    ({ context, page } = await launch(profile));
    await start(page, 'a', 'sqlite');
    const reopened = await call(page, 'a', 'open', { wait: true });
    const verify = await call(page, 'a', 'verify');
    results.crashes.push({
      deletedStayedDeleted: !Object.keys(verify.tails).some((thread) => thread.startsWith('gone-')),
      installError: reopened.installError,
      verify,
    });
    await call(page, 'a', 'retire');
  }

  // 6. Reload race: reload while the leader holds the pool, 20 times; the pool must survive each.
  results.reloadRace = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await start(page, 'a', 'sqlite');
    const opened = await call(page, 'a', 'open', { wait: true });
    const counts = opened.installError ? undefined : await call(page, 'a', 'counts');
    results.reloadRace.push({ events: counts?.events, installError: opened.installError });
    await page.reload();
    await page.waitForFunction(() => document.title === 'bst1940-spike ready');
  }

  // 7. Terminate + immediate reopen in one page, 30 times.
  results.terminateRace = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    await start(page, `w${attempt}`, 'sqlite');
    const opened = await call(page, `w${attempt}`, 'open', { wait: true });
    const counts = opened.installError ? undefined : await call(page, `w${attempt}`, 'counts');
    results.terminateRace.push({ events: counts?.events, installError: opened.installError });
    await page.evaluate((key) => globalThis.spike.terminate(key), `w${attempt}`);
  }

  // 8. Factory reset while the worker holds the pool (contract's removeEntry), then from inside the lock.
  await openPage(page);
  await start(page, 'a', 'sqlite');
  await call(page, 'a', 'open', { wait: true });
  results.resetWhileHeld = await page.evaluate(() =>
    globalThis.spike.resetOpfs(['.brainstrike-sahpool'])
  );
  results.afterResetWhileHeld = {
    counts: await call(page, 'a', 'counts'),
    verify: await call(page, 'a', 'verify'),
  };
  const tab2 = await context.newPage();
  await openPage(tab2);
  await start(tab2, 'b', 'sqlite');
  const queued = call(tab2, 'b', 'open', { wait: true });
  results.wipe = await call(page, 'a', 'wipe');
  results.afterWipeQueuedTab = await queued;
  results.afterWipeQueuedTabCounts = await call(tab2, 'b', 'counts');
  await call(tab2, 'b', 'retire');
  await tab2.close();
  results.opfsAfterWipe = await opfs(page);
  await openPage(page);
  results.contractResetAfterRetire = await page.evaluate(() =>
    globalThis.spike.resetOpfs(['.brainstrike-sahpool'])
  );
  results.opfsAfterContractReset = await opfs(page);

  // 9. Injected one-off acquisition failure (forum 5664cd4b) on 3.53.4: does the pool survive?
  await start(page, 'a', 'sqlite');
  await call(page, 'a', 'open', { wait: true });
  await call(page, 'a', 'appendRun', { seed: 3, steps: 2, threadId: 'precious' });
  results.beforeInjected = await call(page, 'a', 'counts');
  await call(page, 'a', 'retire');
  await page.evaluate(() => globalThis.spike.terminate('a'));
  await start(page, 'f', 'sqlite');
  results.injectedFailure = await call(page, 'f', 'open', { failOnce: true, wait: true });
  await page.evaluate(() => globalThis.spike.terminate('f'));
  results.opfsAfterInjected = await opfs(page);
  await start(page, 'g', 'sqlite');
  results.reopenAfterInjected = await call(page, 'g', 'open', { wait: true });
  results.countsAfterInjected = await call(page, 'g', 'counts');

  await context.close();
  rmSync(profile, { force: true, recursive: true });
  return results;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};
const sum = (values) => values.reduce((total, value) => total + value, 0);

async function perfRun(engine, run, queries) {
  const profile = freshProfile(`perf-${engine}-${run}`);
  const sample = { engine, loadBefore: loadavg()[0], run };
  let { context, page } = await launch(profile);
  const fetched = { cold: new Set(), warm: new Set() };
  let phase = 'cold';
  const record = (ctx) =>
    ctx.on('requestfinished', (request) => fetched[phase].add(new URL(request.url()).pathname));
  record(context);
  await start(page, 'e', engine);
  const cold = await call(
    page,
    'e',
    'open',
    engine === 'sqlite' ? { wait: true } : { dataDir: 'idb://spike-web', firstRun: true }
  );
  sample.coldMs = cold.timings.totalMs;
  sample.cold = cold.timings;
  const burst = await call(page, 'e', 'appendRun', {
    seed: 100 + run,
    steps: 20,
    threadId: 'burst',
  });
  sample.runBatchMs = burst.batchMs;
  sample.runBoundaryMs = burst.boundaryMs;
  sample.runTotalMs = sum(burst.batchMs) + sum(burst.boundaryMs);
  const chunkBurst = await call(page, 'e', 'indexChunks', {
    chunksPerFile: 20,
    fileOffset: 0,
    files: 50,
    linesPerChunk: 12,
    seed: 200 + run,
  });
  sample.chunkBurst1000Ms = chunkBurst.ms;
  let populateMs = chunkBurst.ms;
  for (let batch = 1; batch < 25; batch++) {
    const step = await call(page, 'e', 'indexChunks', {
      chunksPerFile: 20,
      fileOffset: batch * 50,
      files: 50,
      linesPerChunk: 12,
      seed: 200 + run + batch,
    });
    populateMs += step.ms;
  }
  sample.populate25kMs = populateMs;
  if (engine === 'sqlite') {
    sample.history = await call(page, 'e', 'indexHistory', {
      perThread: 50,
      seed: 300 + run,
      threads: 100,
    });
    await call(page, 'e', 'retire');
  } else {
    await call(page, 'e', 'close');
  }
  sample.counts = undefined;
  // Warm start after a full browser restart, then search the 25K-chunk corpus.
  await context.close();
  phase = 'warm';
  ({ context, page } = await launch(profile));
  record(context);
  await start(page, 'e', engine);
  const warm = await call(
    page,
    'e',
    'open',
    engine === 'sqlite' ? { wait: true } : { dataDir: 'idb://spike-web', firstRun: false }
  );
  sample.fetched = { cold: [...fetched.cold].sort(), warm: [...fetched.warm].sort() };
  sample.warmMs = warm.timings.totalMs;
  sample.warm = warm.timings;
  const searched = await call(page, 'e', 'search', { queries });
  sample.search = searched;
  sample.counts = await call(page, 'e', 'counts');
  sample.opfs = (await opfs(page)).estimate;
  sample.loadAfter = loadavg()[0];
  await context.close();
  rmSync(profile, { force: true, recursive: true });
  return sample;
}

async function perf(runs) {
  const recorded = (
    await import('../../test-utils/fixtures/recorded-grep-patterns.json', {
      with: { type: 'json' },
    })
  ).default;
  // 40 recorded patterns, every 29th, so the set is fixed and spread across the fixture.
  const queries = recorded.patterns
    .filter((_, index) => index % 29 === 0)
    .slice(0, 40)
    .map(({ pattern }) => pattern);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    for (const engine of ['sqlite', 'pglite']) {
      samples.push(await perfRun(engine, run, queries));
    }
  }
  const summary = {};
  for (const engine of ['sqlite', 'pglite']) {
    const mine = samples.filter((sample) => sample.engine === engine);
    const stat = (values) => ({ median: median(values), n: values.length, p95: p95(values) });
    summary[engine] = {
      bm25Ms: stat(mine.flatMap((sample) => sample.search.bm25)),
      chunkBurst1000Ms: stat(mine.map((sample) => sample.chunkBurst1000Ms)),
      coldMs: stat(mine.map((sample) => sample.coldMs)),
      grepMs: stat(mine.flatMap((sample) => sample.search.grep)),
      historyMs:
        engine === 'sqlite' ? stat(mine.flatMap((sample) => sample.search.history)) : undefined,
      opfsUsageBytes: stat(mine.map((sample) => sample.opfs.usage)),
      populate25kMs: stat(mine.map((sample) => sample.populate25kMs)),
      runBatchMs: stat(mine.flatMap((sample) => sample.runBatchMs)),
      runBoundaryMs: stat(mine.flatMap((sample) => sample.runBoundaryMs)),
      runTotalMs: stat(mine.map((sample) => sample.runTotalMs)),
      warmMs: stat(mine.map((sample) => sample.warmMs)),
    };
  }
  return { queries, samples, summary };
}

try {
  const result = suite === 'lifecycle' ? await lifecycle() : await perf(Number(runsArg ?? 5));
  writeFileSync(
    out,
    `${JSON.stringify({ identity: { ...identity, loadAtEnd: loadavg() }, result }, null, 2)}\n`
  );
  process.stdout.write(`wrote ${out}\n`);
} finally {
  server.kill('SIGTERM');
}
