#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const resultsPath = path.join(scriptDirectory, 'measure-boot-results.json');
const bootMarkPattern = /^BOOT_MARK (app-ready|agent-host-ready) ([0-9]+(?:\.[0-9]+)?)$/;
const minimumRuns = 10;
// Electron's own SIGTERM handler in apps/desktop/src/main.ts runs a graceful
// shutdown bounded by a 5000ms forced-exit ceiling (SIGNAL_SHUTDOWN_TIMEOUT_MS).
// Give that its full budget plus OS/process-teardown slack before escalating
// to SIGKILL, so a normal graceful shutdown is never mistaken for a hang.
const terminationGraceMs = 7000;

function readOption(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((candidate) => candidate.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function printUsage() {
  process.stdout.write('Usage: node scripts/measure-boot.mjs --label=<name> [options]\n\n');
  process.stdout.write('Options:\n');
  process.stdout.write(
    `  --n=<count>          Measured launches; minimum ${minimumRuns} (default: 10)\n`
  );
  process.stdout.write(
    '  --binary=<path>      Electron executable (default: installed Electron binary)\n'
  );
  process.stdout.write(
    '  --app=<path>         Built app directory passed to Electron (default: desktop package)\n'
  );
  process.stdout.write('  --timeout-ms=<ms>    Per-run timeout (default: 120000)\n');
  process.stdout.write(
    '  --conditions=<text>  Host conditions recorded verbatim with the label\n' +
      '                       (load, concurrent work, how idleness was verified).\n' +
      '                       Defaults to an explicit "unspecified" disclaimer.\n'
  );
  process.stdout.write('  --help               Show this help\n\n');
  process.stdout.write(
    'Methodology notes:\n' +
      '  - Measures the unpackaged main-process boot up to agent-host ready; \n' +
      '    no ELECTRON_IS_E2E_TEST / --test-mode (E2E test mode changes launch \n' +
      '    mode, macOS activation policy, secret handling, and preference \n' +
      "    overrides). Profile isolation uses only Electron's native \n" +
      '    --user-data-dir flag. Three deliberate deviations from a packaged \n' +
      '    user launch, each held constant across labels so relative deltas \n' +
      '    stand: BRAINSTRIKE_DISABLE_FILE_LOGS=1 (skips file-log sink \n' +
      "    construction), --no-sandbox (matches this repo's own unpackaged \n" +
      '    `pnpm start` launch configuration; a packaged app runs sandboxed), \n' +
      '    and quit at agent-host ready (no window/renderer work is in the number).\n' +
      '  - Runs one discarded warm-up launch first (profile creation + PGlite \n' +
      '    migrations happen once, not once per measured run), then reuses that \n' +
      '    same warmed profile directory for all --n measured runs. This reports \n' +
      "    steady-state repeat-boot latency (a returning user's daily launch). \n" +
      '    First-ever-launch (cold) latency is intentionally out of scope: the \n' +
      '    warm-up is unconditional, so no invocation of this harness can \n' +
      '    produce a cold number.\n'
  );
}

function requireNonEmptyOption(name) {
  const value = readOption(name)?.trim();
  if (!value) {
    throw new Error(`--${name}=<value> is required.`);
  }
  return value;
}

function readPositiveInteger(name, fallback) {
  const raw = readOption(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function resolveDefaultElectronBinary() {
  const require = createRequire(path.join(desktopRoot, 'package.json'));
  const electronBinary = require('electron');
  if (typeof electronBinary !== 'string' || !path.isAbsolute(electronBinary)) {
    throw new Error(
      'The installed electron package did not resolve to an absolute executable path.'
    );
  }
  return electronBinary;
}

/**
 * Whole-`..`-segment containment check (BST-1256): a bare `startsWith('..')`
 * misreads in-tree names like "..cache" as an escape. Mirrors the canonical
 * `isPathInsideRoot` in `@brainstrike/file-system/path-validation` (kept
 * inline because this script runs standalone, before any package build).
 */
function isInsideDir(parentDir, candidate) {
  const relative = path.relative(parentDir, candidate);
  return (
    relative === '' ||
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  );
}

export function toRepoRelative(absolutePath) {
  // Never leak a path outside the repo (or the machine-specific prefix that
  // implies) into committed results -- fall back to just the basename. On
  // Windows a target on a different drive comes back drive-qualified and
  // absolute, so treat that as outside the repo too.
  return isInsideDir(repoRoot, absolutePath)
    ? path.relative(repoRoot, absolutePath)
    : path.basename(absolutePath);
}

/**
 * Records which app tree a label measured -- the variable the whole
 * before/after argument turns on. `dirty: true` matters: the Electron 41
 * baseline tree, for example, only becomes measurable by hand-porting the
 * boot marks in as uncommitted edits. A null result is recorded as-is
 * (visible "unknown", never a fabricated value).
 */
function detectAppCommit(appPath) {
  try {
    const runGit = (args) =>
      execFileSync('git', args, { cwd: appPath, encoding: 'utf8', timeout: 15_000 }).trim();
    // The harness writes its own results file into this repo before later
    // labels in the same sitting are captured, so counting that file would
    // pin `dirty` to true on essentially every capture. Excluding only the
    // results file keeps the flag meaning "the measured CODE differed from
    // the recorded sha".
    const statusArgs = ['status', '--porcelain', '--'];
    const measuredTreeTop = runGit(['rev-parse', '--show-toplevel']);
    const resultsInsideMeasuredTree = isInsideDir(measuredTreeTop, resultsPath);
    statusArgs.push(resultsInsideMeasuredTree ? `:(exclude)${resultsPath}` : '.');
    return {
      dirty: runGit(statusArgs).length > 0,
      sha: runGit(['rev-parse', 'HEAD']),
    };
  } catch {
    return null;
  }
}

function detectElectronVersion(binaryPath) {
  try {
    return execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

// No p10/p90: at the enforced minimum n=10, nearest-rank percentiles collapse
// to min and second-from-max -- fields that look like information but are not.
// median/min/max/stdev carry the distribution at this sample size.
export function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length;
  return {
    maxMs: sorted.at(-1),
    medianMs: median,
    minMs: sorted[0],
    stdevMs: Math.sqrt(variance),
  };
}

function parseOutputLine(line, marks) {
  const match = bootMarkPattern.exec(line.trim());
  if (!match) {
    return;
  }
  const [, mark, rawElapsedMs] = match;
  const elapsedMs = Number(rawElapsedMs);
  if (!Number.isFinite(elapsedMs)) {
    throw new Error(`Invalid boot marker duration: ${line}`);
  }
  marks[mark] = elapsedMs;
}

async function runOnce({ appPath, binaryPath, timeoutMs, userDataDirectory }) {
  return await new Promise((resolve, reject) => {
    const marks = {};
    const outputTail = [];
    let stdoutBuffer = '';
    let settled = false;
    // Set once we've decided to kill the child ourselves (timeout or a
    // parse error). The promise only settles from the 'exit' handler, once
    // the OS confirms the process is actually gone -- never immediately on
    // kill() -- so the next sequential run (or the caller's directory
    // cleanup) never races a still-shutting-down process holding the same
    // user-data directory / PGlite files open.
    let pendingError = null;
    let killEscalationTimer = null;
    const spawnEpochMs = performance.timeOrigin + performance.now();
    const child = spawn(
      binaryPath,
      [
        appPath,
        '--no-sandbox',
        '--brainstrike-desktop-launch-mode=built',
        `--user-data-dir=${userDataDirectory}`,
      ],
      {
        cwd: appPath,
        env: {
          ...process.env,
          BRAINSTRIKE_BOOT_MEASURE_QUIT_AFTER_LISTEN: '1',
          BRAINSTRIKE_BOOT_MEASURE_START_MS: String(spawnEpochMs),
          BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const rememberOutput = (text) => {
      outputTail.push(text);
      if (outputTail.length > 80) {
        outputTail.shift();
      }
    };

    function terminate(error) {
      if (pendingError || settled) {
        return;
      }
      pendingError = error;
      child.kill('SIGTERM');
      killEscalationTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, terminationGraceMs);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        rememberOutput(`stdout: ${line}`);
        try {
          parseOutputLine(line, marks);
        } catch (error) {
          terminate(error);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) {
          rememberOutput(`stderr: ${line}`);
        }
      }
    });

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
      }
      if (pendingError) {
        reject(pendingError);
        return;
      }
      if (stdoutBuffer) {
        rememberOutput(`stdout: ${stdoutBuffer}`);
        parseOutputLine(stdoutBuffer, marks);
      }
      if (marks['app-ready'] === undefined || marks['agent-host-ready'] === undefined) {
        reject(
          new Error(
            `Electron exited before all boot marks (code=${String(code)}, signal=${String(signal)}).\n${outputTail.join('\n')}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Electron exited non-zero after measurement (code=${String(code)}, signal=${String(signal)}).\n${outputTail.join('\n')}`
          )
        );
        return;
      }
      resolve({
        agentHostReadyMs: marks['agent-host-ready'],
        appReadyMs: marks['app-ready'],
      });
    });

    const timeout = setTimeout(() => {
      terminate(
        new Error(
          `Electron boot measurement timed out after ${timeoutMs} ms.\n${outputTail.join('\n')}`
        )
      );
    }, timeoutMs);
  });
}

/**
 * Throws unless `parsed` is a valid results document: a plain object with
 * `schemaVersion: 1` and a plain-object (not array) `labels` map. Exported
 * and unit-tested in isolation from file I/O (an array IS an object, and
 * JSON.stringify silently drops non-index properties assigned onto one --
 * the merge would "succeed" in memory and discard the label on write; see
 * scripts/__tests__/measure-boot.test.mjs).
 */
export function validateResultsSchema(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('results root must be an object');
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.labels === null ||
    typeof parsed.labels !== 'object' ||
    Array.isArray(parsed.labels)
  ) {
    throw new Error('unsupported results schema');
  }
}

async function readResults() {
  try {
    const parsed = JSON.parse(await readFile(resultsPath, 'utf8'));
    validateResultsSchema(parsed);
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { labels: {}, schemaVersion: 1 };
    }
    throw new Error(`Could not read ${resultsPath}: ${String(error)}`, { cause: error });
  }
}

function printSummary(label, runCount, summaries) {
  process.stdout.write(`\nBoot measurements: ${label} (n=${runCount})\n`);
  console.table([
    { mark: 'app-ready', ...summaries.appReady },
    { mark: 'agent-host-ready', ...summaries.agentHostReady },
  ]);
}

async function main() {
  if (hasFlag('help')) {
    printUsage();
    return;
  }

  const label = requireNonEmptyOption('label');
  const runCount = readPositiveInteger('n', minimumRuns);
  if (runCount < minimumRuns) {
    throw new Error(`--n must be at least ${minimumRuns}.`);
  }
  const timeoutMs = readPositiveInteger('timeout-ms', 120_000);
  const binaryPath = path.resolve(readOption('binary') ?? resolveDefaultElectronBinary());
  const appPath = path.resolve(readOption('app') ?? desktopRoot);
  const conditions =
    readOption('conditions')?.trim() ||
    'Unspecified: the operator did not record host conditions (--conditions). ' +
      'Treat as an uncontrolled capture.';
  // Fail on a corrupt/unsupported results file NOW, not after N+1 Electron
  // launches whose numbers would be thrown away by the late write. The file
  // is re-read just before the write below so a concurrent capture into a
  // different label is not clobbered with this early snapshot.
  await readResults();
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-boot-measure-'));
  const runs = [];

  try {
    // Discarded warm-up run: the first launch against a fresh profile pays
    // one-time costs (userData directory creation, PGlite bootstrap and
    // migrations) that a returning user's daily boot never pays. Without
    // this, run 1 is not an outlier -- it is simply measuring something
    // different from runs 2..N, which biases the summary statistics (a
    // wide stdev that is really just "cold profile" hiding in the data).
    // All --n measured runs below reuse this same warmed profile directory,
    // so they report steady-state repeat-boot latency.
    process.stdout.write('Warm-up run (discarded, not recorded)... ');
    await runOnce({ appPath, binaryPath, timeoutMs, userDataDirectory });
    process.stdout.write('done\n');

    for (let index = 0; index < runCount; index += 1) {
      process.stdout.write(`Run ${index + 1}/${runCount}... `);
      const run = await runOnce({ appPath, binaryPath, timeoutMs, userDataDirectory });
      runs.push(run);
      process.stdout.write(
        `app-ready=${run.appReadyMs.toFixed(3)} ms, agent-host-ready=${run.agentHostReadyMs.toFixed(3)} ms\n`
      );
    }
  } finally {
    await rm(userDataDirectory, { force: true, recursive: true });
  }

  const summaries = {
    agentHostReady: summarize(runs.map((run) => run.agentHostReadyMs)),
    appReady: summarize(runs.map((run) => run.appReadyMs)),
  };
  // Numbers are printed before any persistence work: a disk/permissions
  // failure on the write must not destroy minutes of idle-host measurement.
  printSummary(label, runCount, summaries);
  const results = await readResults();
  results.labels[label] = {
    appCommit: detectAppCommit(appPath),
    appPath: toRepoRelative(appPath),
    binaryPath: toRepoRelative(binaryPath),
    capturedAt: new Date().toISOString(),
    conditions,
    electronVersion: detectElectronVersion(binaryPath),
    n: runCount,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    runs,
    summaries,
    warmUp: 'discarded (profile-warmed before measured runs; see script header comment)',
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  process.stdout.write(`Results merged into ${resultsPath}\n`);
}

// Only run when executed directly (`node scripts/measure-boot.mjs ...`), not
// when imported -- scripts/__tests__/measure-boot.test.mjs imports this
// module to unit-test the pure helpers above without spawning Electron.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
