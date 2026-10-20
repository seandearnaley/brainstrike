import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../defect-density.mjs', import.meta.url));
const DAY_MS = 86_400_000;
// The fixture repository ignores the developer's git config, hooks and signing.
const ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A repository whose commits are listed oldest first, each dated `daysAgo`. */
function repository(t, commits) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'defect-density-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '-q', '.']);
  for (const { daysAgo, file, subject } of commits) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    appendFileSync(path.join(root, file), `${subject}\n`);
    git(root, ['add', '-A']);
    const date = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    git(root, ['commit', '-q', '-m', subject], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }
  return root;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: ENV });
}

const HISTORY = [
  { daysAgo: 30, file: 'src/host/launcher.ts', subject: 'fix(host): too old to count' },
  { daysAgo: 6, file: 'src/host/launcher.ts', subject: 'fix(host): first' },
  { daysAgo: 5, file: 'src/host/launcher.ts', subject: 'feat(host): a feature is not a fix' },
  { daysAgo: 4, file: 'src/host/close.ts', subject: 'test: second, unscoped' },
  { daysAgo: 3, file: 'src/host/launcher.ts', subject: 'docs(host): not a fix' },
  { daysAgo: 2, file: 'src/host/close.ts', subject: 'revert(host)!: third' },
  { daysAgo: 1, file: 'src/ui/panel.ts', subject: 'fix(ui): another area' },
];

test('counts fix, test and revert commits that touch a path within the window', (t) => {
  const root = repository(t, HISTORY);

  const result = run(root, ['--json', 'src/host', 'src/host/launcher.ts', 'src/ui']);

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.days, 14);
  assert.equal(report.threshold, 3);
  assert.equal(report.hot, true);
  assert.deepEqual(
    report.paths.map(({ commits, count, hot, path: target }) => ({
      count,
      hot,
      subjects: commits.map(({ subject }) => subject),
      target,
    })),
    [
      {
        count: 3,
        hot: true,
        subjects: ['revert(host)!: third', 'test: second, unscoped', 'fix(host): first'],
        target: 'src/host',
      },
      { count: 1, hot: false, subjects: ['fix(host): first'], target: 'src/host/launcher.ts' },
      { count: 1, hot: false, subjects: ['fix(ui): another area'], target: 'src/ui' },
    ]
  );
  assert.match(report.paths[0].commits[0].sha, /^[0-9a-f]{7,}$/u);
  assert.match(report.paths[0].commits[0].date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(report.nightlyIssues.counted, false);
});

test('exits 0 when no path reaches the threshold', (t) => {
  const root = repository(t, HISTORY);

  const result = run(root, ['src/host/launcher.ts', 'src/ui']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, / HOT$/mu);
});

test('--days and --threshold move the verdict', (t) => {
  const root = repository(t, HISTORY);

  assert.equal(run(root, ['--days', '3', 'src/host']).status, 0);
  assert.equal(run(root, ['--threshold', '4', 'src/host']).status, 0);
  assert.equal(run(root, ['--threshold', '1', 'src/ui']).status, 2);
  const wide = JSON.parse(run(root, ['--json', '--days', '60', 'src/host']).stdout);
  assert.equal(wide.paths[0].count, 4);
});

test('the text report marks hot paths, lists their commits and says nightly issues are not counted', (t) => {
  const root = repository(t, HISTORY);

  const { status, stdout } = run(root, ['src/host', 'src/ui']);

  assert.equal(status, 2);
  assert.match(stdout, /^src\/host: 3 HOT$/mu);
  assert.match(stdout, /^src\/ui: 1$/mu);
  assert.match(stdout, /^ {2}[0-9a-f]{7,} \d{4}-\d{2}-\d{2} revert\(host\)!: third$/mu);
  assert.match(stdout, /Nightly-alert issues are not counted/u);
});

test('accepts the separator pnpm forwards before the arguments', (t) => {
  const root = repository(t, HISTORY);

  const result = run(root, ['--', '--json', 'src/host']);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).paths[0].count, 3);
});

test('fails visibly instead of reporting zero', async (t) => {
  const root = repository(t, HISTORY);
  const shallow = mkdtempSync(path.join(os.tmpdir(), 'defect-density-shallow-'));
  t.after(() => rmSync(shallow, { force: true, recursive: true }));
  git(shallow, ['clone', '-q', '--depth', '1', pathToFileURL(root).href, '.']);

  for (const [name, cwd, args, message] of [
    ['no path', root, [], /at least one path/u],
    ['unknown path', root, ['src/hots'], /No commit on this branch touches src\/hots/u],
    ['bad --days', root, ['--days', '0', 'src/host'], /--days must be a positive integer/u],
    ['bad --threshold', root, ['--threshold', 'x', 'src/host'], /--threshold must be/u],
    ['unknown option', root, ['--since', '3', 'src/host'], /--since/u],
    ['shallow clone', shallow, ['src/host'], /shallow/u],
  ]) {
    await t.test(name, () => {
      const result = run(cwd, args);
      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      assert.match(result.stderr, message);
      assert.equal(result.stdout, '');
    });
  }
});
