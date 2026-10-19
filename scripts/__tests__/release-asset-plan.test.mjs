/**
 * A published release asset is never replaced (PR #3870 review, P1). On a rerun
 * the planner keeps an asset whose published sha256 equals the local file's,
 * uploads one that is missing, and refuses everything when any published asset
 * holds different or unverifiable bytes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planReleaseUploads } from '../release-asset-plan.mjs';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../release-asset-plan.mjs'
);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const local = (name, text) => ({ name, path: `assets/${name}`, sha256: sha(text) });
const published = (name, text, state = 'uploaded') => ({
  digest: `sha256:${sha(text)}`,
  name,
  state,
});

test('a missing asset is uploaded', () => {
  assert.deepEqual(planReleaseUploads([local('a.dmg', 'A')], []), {
    keep: [],
    refusals: [],
    upload: ['assets/a.dmg'],
  });
});

test('an identical published asset is kept, not uploaded again', () => {
  const plan = planReleaseUploads(
    [local('a.dmg', 'A'), local('b.exe', 'B')],
    [published('a.dmg', 'A')]
  );
  assert.deepEqual(plan, { keep: ['a.dmg'], refusals: [], upload: ['assets/b.exe'] });
});

test('different published bytes refuse the whole publish and upload nothing', () => {
  const plan = planReleaseUploads(
    [local('a.dmg', 'A-rebuilt'), local('b.exe', 'B')],
    [published('a.dmg', 'A')]
  );
  assert.deepEqual(plan.upload, [], 'nothing is uploaded once any asset is refused');
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0], /a\.dmg is already published with sha256 /u);
  assert.match(plan.refusals[0], new RegExp(sha('A-rebuilt'), 'u'));
});

test('an incomplete or digest-less published asset cannot be verified, so it is refused', () => {
  const incomplete = planReleaseUploads(
    [local('a.dmg', 'A')],
    [published('a.dmg', 'A', 'starter')]
  );
  assert.match(incomplete.refusals.join('\n'), /a\.dmg .*cannot be verified.*state starter/u);
  const digestless = planReleaseUploads(
    [local('a.dmg', 'A')],
    [{ digest: null, name: 'a.dmg', state: 'uploaded' }]
  );
  assert.match(digestless.refusals.join('\n'), /a\.dmg .*cannot be verified.*no digest/u);
  assert.deepEqual([incomplete.upload, digestless.upload], [[], []]);
});

function runCli(files, remote) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-asset-plan-'));
  try {
    const remotePath = path.join(dir, 'published.json');
    writeFileSync(remotePath, JSON.stringify(remote));
    const paths = Object.entries(files).map(([name, text]) => {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      return file;
    });
    const result = spawnSync(process.execPath, [script, '--remote', remotePath, ...paths], {
      encoding: 'utf8',
    });
    return { ...result, dir };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the CLI prints only the files to upload, hashing the local bytes itself', () => {
  const result = runCli({ 'a.dmg': 'A', 'b.exe': 'B' }, [published('a.dmg', 'A')]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [path.join(result.dir, 'b.exe')]);
  assert.match(result.stderr, /keep a\.dmg/u);
});

test('the CLI exits non-zero with no upload list and says to cut a new tag on different bytes', () => {
  const result = runCli({ 'a.dmg': 'A-rebuilt', 'b.exe': 'B' }, [published('a.dmg', 'A')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /::error::a\.dmg is already published with sha256/u);
  assert.match(result.stderr, /never replaced.*new version tag/su);
});
