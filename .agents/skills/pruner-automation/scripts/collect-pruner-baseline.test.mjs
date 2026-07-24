import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseDoctor, parseKnip } from './collect-pruner-baseline.mjs';

const COLLECTOR_PATH = fileURLToPath(new URL('./collect-pruner-baseline.mjs', import.meta.url));

function doctorReport(overrides = {}) {
  return JSON.stringify({
    diagnostics: [],
    directory: '.',
    error: null,
    ok: true,
    projects: [],
    schemaVersion: 1,
    summary: {
      affectedFileCount: 0,
      errorCount: 0,
      score: 100,
      scoreLabel: 'excellent',
      totalDiagnosticCount: 0,
      warningCount: 0,
    },
    version: '0.7.1',
    ...overrides,
  });
}

test('parseDoctor reads a clean scan from the JSON report', () => {
  const result = parseDoctor(doctorReport(), 0);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.errorCount, 0);
  assert.equal(result.incompleteResults, false);
});

test('parseDoctor treats error-severity diagnostics as a findings outcome, not a crash', () => {
  const report = doctorReport({
    summary: {
      affectedFileCount: 2,
      errorCount: 3,
      score: 60,
      scoreLabel: 'needs-work',
      totalDiagnosticCount: 4,
      warningCount: 1,
    },
  });
  // exit 1 is expected here (blocking diagnostics), and must NOT be an error.
  const result = parseDoctor(report, 1);
  assert.equal(result.outcome, 'findings');
  assert.equal(result.errorCount, 3);
  assert.equal(result.warnings, 1);
});

test('parseDoctor surfaces skipped checks as incomplete results', () => {
  const report = doctorReport({
    projects: [{ skippedChecks: ['lint'] }, { skippedChecks: [] }],
  });
  const result = parseDoctor(report, 0);
  assert.equal(result.skippedChecks, 1);
  assert.equal(result.incompleteResults, true);
});

test('parseDoctor fails operationally when the report is ok:false', () => {
  const report = doctorReport({ error: { message: 'boom' }, ok: false });
  assert.throws(() => parseDoctor(report, 1), /failed operationally: boom/);
});

test('parseDoctor fails on non-JSON output rather than degrading silently', () => {
  assert.throws(
    () => parseDoctor('react-doctor crashed before emitting json', 1),
    /parseable JSON report/
  );
});

test('parseDoctor rejects a report missing the summary shape', () => {
  assert.throws(() => parseDoctor(JSON.stringify({ ok: true }), 0), /ok\/summary shape/);
});

test('parseKnip distinguishes findings from operational failure', () => {
  const clean = parseKnip('', 0);
  assert.equal(clean.outcome, 'clean');
  const findings = parseKnip('Unused files (2)\nUnused exports (5)\n', 1);
  assert.equal(findings.outcome, 'findings');
  assert.equal(findings.findingsTotal, 7);
  assert.throws(() => parseKnip('boom', 2), /failed operationally/);
});

// Guards the ESC anchor in stripAnsi: category-name KEYS (uppercase letters
// included) must survive verbatim, and a real ANSI escape sequence must be
// stripped. If the leading ESC were ever dropped from the regex, `[@-Z]`
// would eat uppercase letters and these keys would corrupt — findingsTotal
// alone (digits/parens) would not catch it.
test('parseKnip preserves category-name keys and strips real ANSI sequences', () => {
  const esc = String.fromCharCode(0x1b);
  const raw = `${esc}[1mUnused files${esc}[0m (2)\n${esc}[31mUNUSED Exports${esc}[0m (5)\n`;
  const parsed = parseKnip(raw, 1);
  assert.deepEqual(parsed.categories, { 'UNUSED Exports': 5, 'Unused files': 2 });
  assert.equal(parsed.findingsTotal, 7);
});

function writeFixtureFile(repo, path, contents) {
  const absolutePath = join(repo, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function createCollectorFixture(
  t,
  { installBinaryShims = false, installedLockfile = 'importers: {}\nlockfileVersion: "9.0"\n' } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'pruner-runtime-preflight-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = join(root, 'repo');
  const logsDir = join(root, 'logs');
  const outputPath = join(logsDir, 'baseline.json');
  const binDir = join(root, 'bin');
  const invocationLog = join(root, 'pnpm-invocations.log');
  mkdirSync(repo);
  mkdirSync(logsDir);
  mkdirSync(binDir);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'pruner-test@example.com']);
  git(repo, ['config', 'user.name', 'Pruner Test']);
  writeFixtureFile(
    repo,
    'package.json',
    `${JSON.stringify({
      devDependencies: { knip: '1.0.0', 'react-doctor': '1.0.0' },
      scripts: { doctor: 'react-doctor .' },
    })}\n`
  );
  writeFixtureFile(repo, 'pnpm-workspace.yaml', 'packages: []\n');
  writeFixtureFile(repo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFixtureFile(repo, '.night-shift/PROTOCOL.md', '# Protocol\n');
  writeFixtureFile(repo, '.night-shift/charters/pruner.md', '# Pruner\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  if (installBinaryShims) {
    writeFixtureFile(repo, 'node_modules/.bin/knip', '');
    writeFixtureFile(repo, 'node_modules/.bin/react-doctor', '');
    writeFixtureFile(repo, 'node_modules/.pnpm/lock.yaml', installedLockfile);
  }

  const fakePnpm = join(binDir, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PNPM_INVOCATION_LOG, \`\${process.argv.slice(2).join(' ')}\\n\`);
if (process.argv[2] === 'knip') {
  process.exit(0);
}
process.stdout.write(${JSON.stringify(doctorReport())});
`
  );
  chmodSync(fakePnpm, 0o755);

  return { binDir, invocationLog, logsDir, outputPath, repo, root };
}

function collectFixture(fixture) {
  return spawnSync(
    process.execPath,
    [
      COLLECTOR_PATH,
      '--repo',
      fixture.repo,
      '--logs-dir',
      fixture.logsDir,
      '--output',
      fixture.outputPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        PNPM_INVOCATION_LOG: fixture.invocationLog,
      },
    }
  );
}

test('fails before invoking pnpm when the required dependency binaries are unavailable', (t) => {
  const fixture = createCollectorFixture(t);
  const result = collectFixture(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /required dependency runtime is unavailable/u);
  assert.equal(
    existsSync(fixture.invocationLog),
    false,
    'pnpm must not be invoked during preflight'
  );
  assert.deepEqual(readdirSync(fixture.logsDir), []);
});

test('fails before invoking pnpm when the installed dependency lock is stale', (t) => {
  const fixture = createCollectorFixture(t, {
    installBinaryShims: true,
    installedLockfile: 'importers: {}\nlockfileVersion: "9.0"\nsnapshots: {}\n',
  });
  const result = collectFixture(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /required dependency runtime is stale/u);
  assert.equal(
    existsSync(fixture.invocationLog),
    false,
    'pnpm must not be invoked during freshness preflight'
  );
  assert.deepEqual(readdirSync(fixture.logsDir), []);
});

test('collects only after both required dependency binaries are installed', (t) => {
  const fixture = createCollectorFixture(t, { installBinaryShims: true });
  const result = collectFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.invocationLog, 'utf8').trim().split('\n'), [
    'knip',
    'exec react-doctor . --json',
  ]);
  assert.deepEqual(readdirSync(fixture.logsDir).sort(), [
    'baseline.json',
    'doctor.log',
    'knip.log',
  ]);
  assert.equal(result.stdout, '');
  const evidence = JSON.parse(readFileSync(fixture.outputPath, 'utf8'));
  assert.equal(evidence.knip.outcome, 'clean');
  assert.equal(evidence.doctor.outcome, 'passed');
});
