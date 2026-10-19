import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resultsArtifactPattern } from '../lib/nightly-test-results.mjs';

// BST-2233: every workflow nightly.yml calls shares its run, and with it one
// artifact namespace, so each Notify Linear downloads only the results of the
// jobs it reports. actions/download-artifact matches `pattern` with minimatch,
// as Node's path.matchesGlob does.

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../nightly-results-artifacts.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const DESKTOP = ['desktop-full-regression-gate', 'desktop-embedding-e2e'];

test('the pattern selects each reported job’s artifact and its parts', () => {
  const pattern = resultsArtifactPattern(DESKTOP);
  for (const name of [
    'nightly-results--desktop-full-regression-gate--shard-1',
    'nightly-results--desktop-full-regression-gate--shard-4',
    'nightly-results--desktop-embedding-e2e',
  ]) {
    assert.ok(path.matchesGlob(name, pattern), `${pattern} must select ${name}`);
  }
});

test('the pattern selects no other job’s results and no other artifact', () => {
  const pattern = resultsArtifactPattern(DESKTOP);
  for (const name of [
    'nightly-results--web-full-regression',
    'nightly-results--desktop-full-regression',
    'nightly-results--desktop-full-regression-gate-extra',
    'nightly-results--desktop-embedding-e2e-extra--main',
    'desktop-full-regression-shard-1-test-results',
  ]) {
    assert.ok(!path.matchesGlob(name, pattern), `${pattern} must not select ${name}`);
  }
});

test('one job still forms a brace set: minimatch reads {job} literally', () => {
  assert.ok(
    !path.matchesGlob(
      'nightly-results--web-full-regression',
      'nightly-results--{web-full-regression}'
    )
  );
  const pattern = resultsArtifactPattern(['web-full-regression']);
  assert.ok(path.matchesGlob('nightly-results--web-full-regression', pattern), pattern);
});

test('a job name that is not a plain artifact segment is refused', () => {
  for (const jobs of [[], [''], ['a--b'], ['a*'], ['a,b'], ['{a}'], ['a b']]) {
    assert.throws(() => resultsArtifactPattern(jobs), /results job/u, JSON.stringify(jobs));
  }
});

test('the CLI prints the pattern of the --results jobs for $GITHUB_OUTPUT', () => {
  const result = run(
    '--results',
    'desktop-full-regression-gate=failure,desktop-embedding-e2e=success'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `pattern=${resultsArtifactPattern(DESKTOP)}\n`);
});

test('the CLI fails, printing nothing, on a malformed or missing --results', () => {
  for (const args of [[], ['--results', 'no-result'], ['--results', 'a--b=success']]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '', JSON.stringify(args));
    assert.match(result.stderr, /^nightly-results-artifacts: /u);
  }
});
