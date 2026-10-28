#!/usr/bin/env node
// Rewrites e2e/file-durations.json, the per-file seconds e2e/file-shards.ts
// balances the desktop E2E shards with, from the list reporter's lines in the
// logs of several green merge-queue runs, one log file per run:
//
//   gh run view <run-id> --log > run-<run-id>.log   (for each run)
//   node scripts/update-e2e-file-durations.mjs run-*.log
//
// One run is not enough: in each of five queue runs, one shard's runner ran its
// tests 1.2 to 1.4 times slower than the same tests ran elsewhere, so a single
// run's times mislead the plan (runs 40777356325 to 40783192364). Each passed
// test's time is its mean over the runs it passed in, keyed by project
// (`[smoke]` or `[regression]`) and title, so a test that moved lines still
// counts once. A file's entry is the sum of its tests in that project, since one
// file can hold tests of both. Packaged lanes print `[regression]` lines too, but
// the shards never see those files (`--grep-invert=@packaged`), so their entries
// go unused.
import { readFileSync, writeFileSync } from 'node:fs';

const PASSED =
  /✓\s+\d+ \[(regression|smoke)\] › e2e\/(\S+?):\d+:\d+ › (.*) \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/u;
/** @type {Record<string, number>} */
const SECONDS_PER_UNIT = { m: 60, ms: 0.001, s: 1 };

const logs = process.argv.slice(2);
if (logs.length === 0) {
  throw new Error('Pass the log file of each green merge-queue run.');
}

/** @type {Map<string, { project: string; file: string; seconds: number[] }>} */
const tests = new Map();
for (const log of logs) {
  /** @type {Map<string, number>} */
  const run = new Map();
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const match = PASSED.exec(line);
    if (match) {
      const [, project = '', file = '', test = '', amount = '', unit = ''] = match;
      const key = `${project}:${file}:${test}`;
      run.set(key, Number(amount) * (SECONDS_PER_UNIT[unit] ?? Number.NaN));
      if (!tests.has(key)) {
        tests.set(key, { file, project, seconds: [] });
      }
    }
  }
  if (run.size === 0) {
    throw new Error(`No passed [regression] or [smoke] test lines in ${log}.`);
  }
  for (const [key, seconds] of run) {
    tests.get(key)?.seconds.push(seconds);
  }
}

/** @type {Map<string, Map<string, number>>} */
const projects = new Map();
for (const { project, file, seconds } of tests.values()) {
  const mean = seconds.reduce((sum, s) => sum + s, 0) / seconds.length;
  const files = projects.get(project) ?? new Map();
  files.set(file, (files.get(file) ?? 0) + mean);
  projects.set(project, files);
}
/** @type {Record<string, Record<string, number>>} */
const durations = {};
for (const [project, files] of [...projects].sort(([a], [b]) => (a < b ? -1 : 1))) {
  durations[project] = Object.fromEntries(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, s]) => [file, Math.round(s * 10) / 10])
  );
}
writeFileSync(
  new URL('../e2e/file-durations.json', import.meta.url),
  `${JSON.stringify(durations, null, 2)}\n`
);
console.log(
  `Recorded ${tests.size} tests from ${logs.length} runs: ${[...projects].map(([project, files]) => `${files.size} ${project} files`).join(', ')}.`
);
