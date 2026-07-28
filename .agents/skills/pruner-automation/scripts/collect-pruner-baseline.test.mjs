import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  {
    crossWorktreeRuntime = null,
    installBinaryShims = false,
    installedLockfile = 'importers: {}\nlockfileVersion: "9.0"\n',
    manifestLockMismatch = false,
    nestedWorktree = false,
  } = {}
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
      // BST-852: the root script is named `react-doctor`, not `doctor` — a
      // script named `doctor` is unreachable via the bare `pnpm doctor`
      // shorthand because pnpm's builtin subcommand claims it.
      scripts: { 'react-doctor': 'react-doctor .' },
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

  // BST-830: a sibling worktree whose runtime is lock-COMPATIBLE, so every
  // existing preflight (binaries present, .pnpm/lock.yaml deep-equal,
  // frozen-lockfile manifests) passes while the runtime is not this
  // worktree's. Each variant links a different rung of the chain.
  if (crossWorktreeRuntime) {
    // nestedWorktree places the foreign runtime UNDER the repo root, the way
    // this repository nests sibling worktrees at .claude/worktrees/. Plain
    // containment inside repoRoot passes there, so the gate has to resolve
    // against repoRoot/node_modules instead.
    const other = nestedWorktree
      ? join(repo, '.claude/worktrees/other')
      : join(root, 'other-worktree');
    writeFixtureFile(other, 'node_modules/.bin/knip', '');
    writeFixtureFile(other, 'node_modules/.bin/react-doctor', '');
    writeFixtureFile(other, 'node_modules/.pnpm/lock.yaml', installedLockfile);
    if (crossWorktreeRuntime === 'node-modules') {
      rmSync(join(repo, 'node_modules'), { force: true, recursive: true });
      symlinkSync(join(other, 'node_modules'), join(repo, 'node_modules'), 'dir');
    } else if (crossWorktreeRuntime === 'virtual-store') {
      rmSync(join(repo, 'node_modules/.pnpm'), { force: true, recursive: true });
      symlinkSync(join(other, 'node_modules/.pnpm'), join(repo, 'node_modules/.pnpm'), 'dir');
    } else if (crossWorktreeRuntime === 'binary') {
      rmSync(join(repo, 'node_modules/.bin/knip'), { force: true });
      symlinkSync(join(other, 'node_modules/.bin/knip'), join(repo, 'node_modules/.bin/knip'));
    } else {
      throw new Error(`unknown crossWorktreeRuntime variant: ${crossWorktreeRuntime}`);
    }
  }

  const fakePnpm = join(binDir, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PNPM_INVOCATION_LOG, \`\${process.argv.slice(2).join(' ')}\\n\`);
if (process.argv[2] === 'install') {
  if (${JSON.stringify(manifestLockMismatch)}) {
    process.stderr.write('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile\\n');
    process.exit(1);
  }
  process.exit(0);
}
if (process.argv[2] === 'knip') {
  process.exit(0);
}
process.stdout.write(${JSON.stringify(doctorReport())});
`
  );
  chmodSync(fakePnpm, 0o755);

  return { binDir, invocationLog, logsDir, outputPath, repo, root };
}

function collectFixture(fixture, collectorPath = COLLECTOR_PATH) {
  return spawnSync(
    process.execPath,
    [
      collectorPath,
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

test('reports the install remedy when the lockfile parser is not installed', (t) => {
  const fixture = createCollectorFixture(t, { installBinaryShims: true });
  const copiedCollectorPath = join(fixture.root, 'collect-pruner-baseline.mjs');
  copyFileSync(COLLECTOR_PATH, copiedCollectorPath);
  const isolatedCollectorPath = realpathSync(copiedCollectorPath);
  const result = collectFixture(fixture, isolatedCollectorPath);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /required dependency runtime is unavailable/u);
  assert.match(result.stderr, /pnpm install --frozen-lockfile/u);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
  assert.equal(
    existsSync(fixture.invocationLog),
    false,
    'pnpm must not be invoked when the lockfile parser is unavailable'
  );
  assert.deepEqual(readdirSync(fixture.logsDir), []);
});

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

// BST-830. A detached worktree can carry a node_modules/ that resolves into
// ANOTHER worktree's already-installed, lock-compatible runtime. Every prior
// preflight passes, then `pnpm knip` enters pnpm's dependency-status path and
// auto-installs — running node-gyp and postinstall lifecycle scripts despite
// this collector's read-only contract. The runtime must be proven to BELONG to
// this worktree before pnpm is invoked at all.
for (const variant of ['node-modules', 'virtual-store', 'binary']) {
  test(`fails before invoking pnpm when the ${variant} runtime belongs to another worktree`, (t) => {
    const fixture = createCollectorFixture(t, {
      crossWorktreeRuntime: variant,
      installBinaryShims: true,
    });
    const result = collectFixture(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /dependency runtime belongs to another worktree/u);
    assert.match(result.stderr, /pnpm install --frozen-lockfile/u);
    assert.equal(
      existsSync(fixture.invocationLog),
      false,
      'pnpm must not be invoked once the runtime is proven foreign'
    );
    assert.deepEqual(readdirSync(fixture.logsDir), []);
  });
}

// A nested worktree is INSIDE repoRoot, so plain repo containment accepts it.
// This repository nests them at .claude/worktrees/, making it the realistic
// shape rather than a hypothetical one.
for (const variant of ['node-modules', 'virtual-store', 'binary']) {
  test(`fails when the ${variant} runtime belongs to a worktree nested inside this one`, (t) => {
    const fixture = createCollectorFixture(t, {
      crossWorktreeRuntime: variant,
      installBinaryShims: true,
      nestedWorktree: true,
    });
    const result = collectFixture(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /dependency runtime belongs to another worktree/u);
    assert.match(result.stderr, /not inside/u);
    assert.equal(
      existsSync(fixture.invocationLog),
      false,
      'pnpm must not be invoked for a nested foreign runtime either'
    );
    assert.deepEqual(readdirSync(fixture.logsDir), []);
  });
}

test('accepts a runtime that resolves entirely inside this worktree', (t) => {
  const fixture = createCollectorFixture(t, { installBinaryShims: true });
  const result = collectFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /belongs to another worktree/u);
});

test('fails before scans when workspace manifests do not satisfy the lockfile', (t) => {
  const fixture = createCollectorFixture(t, {
    installBinaryShims: true,
    manifestLockMismatch: true,
  });
  const result = collectFixture(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /required dependency runtime is stale/u);
  assert.deepEqual(readFileSync(fixture.invocationLog, 'utf8').trim().split('\n'), [
    'install --lockfile-only --frozen-lockfile --ignore-scripts --offline --trust-lockfile',
  ]);
  assert.deepEqual(readdirSync(fixture.logsDir), []);
});

test('collects only after both required dependency binaries are installed', (t) => {
  const fixture = createCollectorFixture(t, { installBinaryShims: true });
  const result = collectFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.invocationLog, 'utf8').trim().split('\n'), [
    'install --lockfile-only --frozen-lockfile --ignore-scripts --offline --trust-lockfile',
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
