import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  collectFilesByExtension,
  isForeignCheckout,
  REPO_ROOT_IGNORED_DIRECTORIES,
} from '../lib/repo-root-walk.mjs';

// Guards the shared ignore set for repo-root-rooted walks. The failure this
// protects against is not a slow test: a root walk that descends into a
// gitignored copy of the repository reports THAT copy's files as this
// repository's, so a guard fails on a branch nobody pointed it at.

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-root-walk-'));
  for (const relative of files) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, '');
  }
  return root;
}

test('every ignored directory is actually skipped by a root walk', () => {
  const tracked = 'packages/config/keep.css';
  const root = fixture([
    tracked,
    ...[...REPO_ROOT_IGNORED_DIRECTORIES].map((directory) => `${directory}/buried.css`),
  ]);
  assert.deepEqual(
    collectFilesByExtension(root, ['.css'])
      .get('.css')
      .map((file) => path.relative(root, file)),
    [tracked]
  );
});

test('a vendored worktree checkout under .claude is not reported as this repository', () => {
  const root = fixture([
    '.claude/worktrees/stale-branch/apps/web/tailwind.config.js',
    '.claude/worktrees/stale-branch/apps/web/app.css',
    '.claude/skills/helper/example.css',
  ]);
  const found = collectFilesByExtension(root, ['tailwind.config.js', '.css']);
  assert.deepEqual(found.get('tailwind.config.js'), []);
  assert.deepEqual(found.get('.css'), []);
});

test('one traversal buckets every requested extension, each sorted', () => {
  const root = fixture([
    'b/second.css',
    'a/first.css',
    'a/only.ts',
    'c/nested/deep.ts',
    'ignored.txt',
  ]);
  const found = collectFilesByExtension(root, ['.css', '.ts']);
  assert.deepEqual(
    found.get('.css').map((file) => path.relative(root, file)),
    [path.join('a', 'first.css'), path.join('b', 'second.css')]
  );
  assert.deepEqual(
    found.get('.ts').map((file) => path.relative(root, file)),
    [path.join('a', 'only.ts'), path.join('c', 'nested', 'deep.ts')]
  );
});

test('a missing walk root fails loudly rather than reporting an empty tree', () => {
  assert.throws(
    () => collectFilesByExtension(path.join(os.tmpdir(), 'repo-root-walk-absent'), ['.css']),
    { code: 'ENOENT' }
  );
});

test('a checkout parked by an unnamed tool is skipped without being on the list', () => {
  // The point of the structural rule: `.some-future-agent` is in no ignore
  // set, and must still not be mistaken for this repository's content.
  const tool = '.some-future-agent';
  assert.ok(
    !REPO_ROOT_IGNORED_DIRECTORIES.has(tool),
    'fixture is only meaningful while the directory is unlisted'
  );
  const root = fixture([
    'packages/config/keep.css',
    `${tool}/worktrees/branch-x/.git`,
    `${tool}/worktrees/branch-x/packages/config/stale.css`,
  ]);
  assert.deepEqual(
    collectFilesByExtension(root, ['.css'])
      .get('.css')
      .map((file) => path.relative(root, file)),
    [path.join('packages', 'config', 'keep.css')]
  );
});

test('a plain directory that merely looks like scratch space is still walked', () => {
  // The rule must not swallow real content: no `.git`, no skip.
  const root = fixture(['tools/generated/theme.css']);
  assert.deepEqual(
    collectFilesByExtension(root, ['.css'])
      .get('.css')
      .map((file) => path.relative(root, file)),
    [path.join('tools', 'generated', 'theme.css')]
  );
  assert.equal(isForeignCheckout(path.join(root, 'tools')), false);
});
