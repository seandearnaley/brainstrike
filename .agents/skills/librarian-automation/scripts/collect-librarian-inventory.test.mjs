import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-librarian-inventory.mjs'
);

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(repo, message) {
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', message], repo);
}

function charter(nameLine, learningsFile, schedule = '0 1 * * *') {
  return [
    '# Fixture charter',
    '',
    '```',
    nameLine,
    `SCHEDULE="${schedule}"`,
    `LEARNINGS_FILE="${learningsFile}"`,
    '```',
    '',
  ].join('\n');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-collector-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'librarian@example.test'], repo);
  run('git', ['config', 'user.name', 'Librarian Test'], repo);
  write(repo, '.night-shift/PROTOCOL.md', '# Protocol\n');
  write(repo, '.night-shift/charters/alpha.md', charter('NAME=Alpha', '.night-shift/alpha.md'));
  write(
    repo,
    '.night-shift/charters/missing.md',
    charter('NAME=Missing', '.night-shift/missing.md')
  );
  write(repo, '.night-shift/charters/README.md', '# Not a charter\n');
  write(
    repo,
    '.night-shift/alpha.md',
    [
      '# Alpha 2020-01-01',
      '',
      '- Durable invariant.',
      '- Found on 2026-07-20 in the code.',
      '- ran unit checks',
      '- run a manual review',
      '',
    ].join('\n')
  );
  write(repo, '.night-shift/orphan.md', '# Orphan\n\n- Still useful.\n');
  const bulletin = [
    '# Bulletin',
    'Hard cap 2 entry lines; trim oldest first.',
    '- [from:alpha 2026-07-18] One',
    '- [from:alpha 2026-07-19] Two',
    '- [from:alpha 2026-07-20] Three',
    '',
  ].join('\n');
  write(repo, '.night-shift/bulletin.md', bulletin);
  commitAll(repo, 'fixture');
  return { bulletin, repo, root };
}

function collect(repo) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repo', repo, '--revision', 'HEAD'], {
    encoding: 'utf8',
  });
}

test('collects charter cross-references, bulletin state, orphans, and smell candidates', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture.repo);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);

  assert.equal(inventory.schema, 'collect-librarian-inventory');
  assert.deepEqual(inventory.charters, [
    {
      file: '.night-shift/charters/alpha.md',
      learningsFile: '.night-shift/alpha.md',
      learningsFileExists: true,
      name: 'Alpha',
    },
    {
      file: '.night-shift/charters/missing.md',
      learningsFile: '.night-shift/missing.md',
      learningsFileExists: false,
      name: 'Missing',
    },
  ]);
  assert.deepEqual(inventory.orphanLearningsFiles, ['.night-shift/orphan.md']);
  assert.deepEqual(inventory.bulletin, {
    cap: 2,
    entryCount: 3,
    overCap: true,
    sha256: createHash('sha256').update(fixture.bulletin).digest('hex'),
  });
  assert.deepEqual(inventory.smellCandidates, [
    {
      excerpt: '- Found on 2026-07-20 in the code.',
      file: '.night-shift/alpha.md',
      kind: 'timestamp-content',
      line: 4,
    },
    {
      excerpt: '- ran unit checks',
      file: '.night-shift/alpha.md',
      kind: 'run-log',
      line: 5,
    },
    {
      excerpt: '- run a manual review',
      file: '.night-shift/alpha.md',
      kind: 'run-log',
      line: 6,
    },
  ]);
});

test('reports a bulletin under its declared cap at the selected revision', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(
    fixture.repo,
    '.night-shift/bulletin.md',
    '# Bulletin\nHard cap 4 entry lines; trim oldest first.\n- [from:alpha 2026-07-20] One\n'
  );
  commitAll(fixture.repo, 'bulletin under cap');

  const result = collect(fixture.repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (({ cap, entryCount, overCap }) => ({ cap, entryCount, overCap }))(
      JSON.parse(result.stdout).bulletin
    ),
    { cap: 4, entryCount: 1, overCap: false }
  );
});

test('fails closed when the work tree lacks PROTOCOL.md', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  fs.rmSync(path.join(fixture.repo, '.night-shift/PROTOCOL.md'));

  const result = collect(fixture.repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^collect-librarian-inventory: .*does not contain.*PROTOCOL\.md/mu);
});

test('fails closed when the bulletin omits its cap phrase', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(fixture.repo, '.night-shift/bulletin.md', '# Bulletin\nNo declared limit.\n');
  commitAll(fixture.repo, 'remove cap declaration');

  const result = collect(fixture.repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lacks the "Hard cap N entry lines" declaration/u);
});

test('fails closed when a charter lacks NAME', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(
    fixture.repo,
    '.night-shift/charters/alpha.md',
    charter('ROLE=No name here', '.night-shift/alpha.md')
  );
  commitAll(fixture.repo, 'remove charter name');

  const result = collect(fixture.repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /alpha\.md charter meta block lacks NAME/u);
});
