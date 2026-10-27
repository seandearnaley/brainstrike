#!/usr/bin/env node
// Rewrites e2e/file-durations.json, the per-file seconds e2e/file-shards.ts
// balances the regression shards with, from the list reporter's lines in a
// green merge-queue run's log:
//
//   gh run view <run-id> --log | node scripts/update-e2e-file-durations.mjs
//
// Every passed `[regression]` test counts once; a file's entry is the sum of
// its tests. Packaged lanes print `[regression]` lines too, but the shards
// never see those files (`--grep-invert=@packaged`), so their entries go unused.
import { readFileSync, writeFileSync } from 'node:fs';

const PASSED =
  /✓\s+\d+ \[regression\] › e2e\/(\S+?):(\d+:\d+ › .*) \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/u;
/** @type {Record<string, number>} */
const SECONDS_PER_UNIT = { m: 60, ms: 0.001, s: 1 };

/** @type {Map<string, { file: string; seconds: number }>} */
const tests = new Map();
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const match = PASSED.exec(line);
  if (match) {
    const [, file = '', test = '', amount = '', unit = ''] = match;
    tests.set(`${file}:${test}`, {
      file,
      seconds: Number(amount) * (SECONDS_PER_UNIT[unit] ?? Number.NaN),
    });
  }
}
if (tests.size === 0) {
  throw new Error('No passed [regression] test lines on stdin.');
}

/** @type {Map<string, number>} */
const files = new Map();
for (const { file, seconds } of tests.values()) {
  files.set(file, (files.get(file) ?? 0) + seconds);
}
const durations = Object.fromEntries(
  [...files.keys()].sort().map((file) => [file, Math.round((files.get(file) ?? 0) * 10) / 10])
);
writeFileSync(
  new URL('../e2e/file-durations.json', import.meta.url),
  `${JSON.stringify(durations, null, 2)}\n`
);
console.log(`Recorded ${tests.size} tests in ${files.size} files.`);
