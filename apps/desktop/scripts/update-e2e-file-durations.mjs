#!/usr/bin/env node
// Rewrites e2e/file-durations.json, the per-file seconds e2e/file-shards.ts
// balances the desktop E2E shards with, from the list reporter's lines in a
// green merge-queue run's log:
//
//   gh run view <run-id> --log | node scripts/update-e2e-file-durations.mjs
//
// Every passed test counts once under its project (`[smoke]` or
// `[regression]`); a file's entry is the sum of its tests in that project, since
// one file can hold tests of both. Packaged lanes print `[regression]` lines
// too, but the shards never see those files (`--grep-invert=@packaged`), so
// their entries go unused.
import { readFileSync, writeFileSync } from 'node:fs';

const PASSED =
  /✓\s+\d+ \[(regression|smoke)\] › e2e\/(\S+?):(\d+:\d+ › .*) \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/u;
/** @type {Record<string, number>} */
const SECONDS_PER_UNIT = { m: 60, ms: 0.001, s: 1 };

/** @type {Map<string, { project: string; file: string; seconds: number }>} */
const tests = new Map();
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const match = PASSED.exec(line);
  if (match) {
    const [, project = '', file = '', test = '', amount = '', unit = ''] = match;
    tests.set(`${project}:${file}:${test}`, {
      file,
      project,
      seconds: Number(amount) * (SECONDS_PER_UNIT[unit] ?? Number.NaN),
    });
  }
}
if (tests.size === 0) {
  throw new Error('No passed [regression] or [smoke] test lines on stdin.');
}

/** @type {Map<string, Map<string, number>>} */
const projects = new Map();
for (const { project, file, seconds } of tests.values()) {
  const files = projects.get(project) ?? new Map();
  files.set(file, (files.get(file) ?? 0) + seconds);
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
  `Recorded ${tests.size} tests: ${[...projects].map(([project, files]) => `${files.size} ${project} files`).join(', ')}.`
);
