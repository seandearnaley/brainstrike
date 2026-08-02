import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarize, toRepoRelative, validateResultsSchema } from '../measure-boot.mjs';

// scripts/measure-boot.mjs is a manually-invoked benchmark CLI, not wired
// into any unit lane (it isn't under `src/`, isn't `.ts`, and the desktop
// vitest config explicitly excludes `**/scripts/**`, with script-helper
// coverage done via node:test directly -- see
// apps/desktop/scripts/__tests__/start-agent-devtools-session.test.mjs for
// the established pattern this file follows). Its process-spawning,
// Electron-launching parts are verified against the real binary throughout
// BST-1064's PR history, not here. This file covers only the pure helpers
// that review flagged real bugs in: schema validation (round 2 finding --
// array-shaped `labels` silently discarding the merge) and path redaction
// (round 2 finding -- Windows cross-drive paths bypassing redaction).

test('validateResultsSchema accepts a well-formed document', () => {
  assert.doesNotThrow(() => validateResultsSchema({ labels: {}, schemaVersion: 1 }));
  assert.doesNotThrow(() =>
    validateResultsSchema({ labels: { 'a-label': { n: 10 } }, schemaVersion: 1 })
  );
});

test('validateResultsSchema rejects a non-object root', () => {
  assert.throws(() => validateResultsSchema(null), /results root must be an object/);
  assert.throws(() => validateResultsSchema('nope'), /results root must be an object/);
  assert.throws(() => validateResultsSchema([]), /results root must be an object/);
});

test('validateResultsSchema rejects the wrong schemaVersion', () => {
  assert.throws(
    () => validateResultsSchema({ labels: {}, schemaVersion: 2 }),
    /unsupported results schema/
  );
});

test('validateResultsSchema rejects array-shaped labels (round 2 finding)', () => {
  // `[]` passes `typeof === 'object'`; without the explicit Array.isArray
  // check this document would previously validate, the merge would appear
  // to succeed in memory, and JSON.stringify would then silently drop the
  // new label because array properties that aren't numeric indices are
  // omitted -- reporting success while writing nothing.
  assert.throws(
    () => validateResultsSchema({ labels: [], schemaVersion: 1 }),
    /unsupported results schema/
  );
});

test('validateResultsSchema rejects a null labels field', () => {
  assert.throws(
    () => validateResultsSchema({ labels: null, schemaVersion: 1 }),
    /unsupported results schema/
  );
});

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

test('toRepoRelative returns a repo-relative path for a path inside the repo', () => {
  const target = path.join(repoRoot, 'apps', 'desktop', 'package.json');
  assert.equal(toRepoRelative(target), path.join('apps', 'desktop', 'package.json'));
});

test('toRepoRelative falls back to a bare basename for a path outside the repo', () => {
  // The general "outside the repo" case, reachable on any OS via a `..`
  // escape (e.g. a scratch clone in a sibling directory, as this PR's own
  // Electron 41.10.0 baseline captures used).
  const outsidePath = path.resolve(repoRoot, '..', 'some-scratch-clone', 'Electron');
  assert.equal(toRepoRelative(outsidePath), 'Electron');
  assert.doesNotMatch(toRepoRelative(outsidePath), /\.\./);
});

test('toRepoRelative never leaks an absolute path (round 2 finding)', () => {
  // Windows cross-drive case specifically (e.g. D:\tools\Electron.exe
  // against a C:\ repo root) can't be constructed on POSIX -- there is no
  // drive-letter concept for path.relative to disagree about -- so this
  // asserts the general contract the fix restores: whatever
  // toRepoRelative returns is never itself an absolute path, on any
  // platform. That is the exact property the Windows case violated (an
  // unredacted absolute path landing verbatim in committed results).
  const outsidePath = path.resolve(repoRoot, '..', 'some-scratch-clone', 'Electron');
  const result = toRepoRelative(outsidePath);
  assert.equal(path.isAbsolute(result), false);
});

test('summarize computes median/min/max/stdev and omits p10/p90 (round 3 finding)', () => {
  const summary = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(summary.minMs, 10);
  assert.equal(summary.maxMs, 100);
  assert.equal(summary.medianMs, 55);
  assert.ok(summary.stdevMs > 0);
  // Nearest-rank p10/p90 are degenerate at n=10 (p10 always equals min, p90
  // always equals max) -- dropped rather than shipped as a field that
  // silently duplicates another field.
  assert.equal('p10Ms' in summary, false);
  assert.equal('p90Ms' in summary, false);
});

test('summarize reports zero spread for a single-run sample', () => {
  const summary = summarize([842.1]);
  assert.equal(summary.medianMs, 842.1);
  assert.equal(summary.minMs, 842.1);
  assert.equal(summary.maxMs, 842.1);
  assert.equal(summary.stdevMs, 0);
});
