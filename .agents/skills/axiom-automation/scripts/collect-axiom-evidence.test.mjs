import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-axiom-evidence.mjs'
);

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-collector-'));
  const repo = path.join(root, 'brainstrike');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'axiom@example.test'], repo);
  run('git', ['config', 'user.name', 'Axiom Test'], repo);
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/brainstrike.git'], repo);

  write(repo, 'AGENTS.md', '# Rules\n\nCapabilities MUST fail visibly.\n');
  write(
    repo,
    'docs/agents/database.md',
    '# Database\n\nCatalog refreshes MUST preserve user choice.\n'
  );
  write(repo, '.night-shift/PROTOCOL.md', '# Protocol\n\nOne open PR per loop.\n');
  write(repo, '.night-shift/charters/README.md', '# Charters\n\nFirst runs use a full sweep.\n');
  write(
    repo,
    '.night-shift/charters/axiom.md',
    '# Axiom\n\n```\nNAME=Axiom\nROLE=invariant maintainer\nCHARTER_VERSION=1\nSTATE_ISSUE="[automation-state] Axiom"\nLEARNINGS_FILE=".night-shift/axiom.md"\n```\n'
  );
  write(repo, '.night-shift/axiom.md', '# Axiom learnings\n');
  write(repo, 'scripts/example-guard.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/verify-imports.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/model-catalog-contract.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/oddly-named-rules.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/indirect-rules.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/build-report.mjs', "process.stdout.write('ok\\n');\n");
  write(repo, 'scripts/__tests__/example-guard.test.mjs', '// paired test\n');
  write(
    repo,
    'package.json',
    JSON.stringify(
      {
        name: 'fixture',
        scripts: {
          'arch:rules': 'node scripts/indirect-rules.mjs',
          lint: 'node scripts/example-guard.mjs',
          'lint:ci': 'pnpm lint && pnpm run arch:rules && node scripts/oddly-named-rules.mjs',
          'test:scripts': 'node --test scripts/__tests__/*.test.mjs',
        },
      },
      null,
      2
    )
  );
  write(repo, 'packages/app/src/original.ts', 'export const original = true;\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'fixture base'], repo);
  const watermark = run('git', ['rev-parse', 'HEAD'], repo);

  write(repo, 'packages/app/src/changed.ts', 'export const changed = true;\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'fixture change'], repo);
  const head = run('git', ['rev-parse', 'HEAD'], repo);
  run('git', ['update-ref', 'refs/remotes/origin/main', head], repo);

  const ghStub = path.join(bin, 'gh');
  fs.writeFileSync(
    ghStub,
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.AXIOM_GH_STUB_OUTPUT || '[]');\n"
  );
  fs.chmodSync(ghStub, 0o755);

  return { bin, head, repo, root, watermark };
}

function collect(fixture, args, pullRequests = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repo', fixture.repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AXIOM_GH_STUB_OUTPUT: JSON.stringify(pullRequests),
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    },
  });
}

test('collects live invariant, guard, delta, and Axiom PR evidence', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const pullRequest = {
    baseRefName: 'main',
    headRefName: 'night-shift/axiom/example',
    headRefOid: fixture.head,
    isDraft: true,
    number: 42,
    title: 'Axiom: example',
    url: 'https://github.com/example/brainstrike/pull/42',
  };

  const result = collect(fixture, ['--watermark', fixture.watermark], [pullRequest]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.delta.mode, 'main-diff');
  assert.equal(evidence.delta.watermark, fixture.watermark);
  assert.deepEqual(evidence.delta.files, ['packages/app/src/changed.ts']);
  assert.ok(
    evidence.invariantStatements.some(
      (statement) => statement.file === 'docs/agents/database.md' && statement.line === 3
    )
  );
  assert.ok(evidence.scriptInventory.guardCandidates.includes('scripts/example-guard.mjs'));
  assert.ok(evidence.scriptInventory.wiredGuardCandidates.includes('scripts/example-guard.mjs'));
  assert.deepEqual(
    evidence.openPullRequests.map((item) => item.number),
    [42]
  );
});

test('treats verify/contract names and lint-wired scripts as guard candidates', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, ['--watermark', fixture.watermark]);
  assert.equal(result.status, 0, result.stderr);
  const { guardCandidates, wiredGuardCandidates } = JSON.parse(result.stdout).scriptInventory;

  assert.ok(guardCandidates.includes('scripts/verify-imports.mjs'));
  assert.ok(guardCandidates.includes('scripts/model-catalog-contract.mjs'));
  assert.ok(
    guardCandidates.includes('scripts/oddly-named-rules.mjs'),
    'lint:ci wiring beats naming'
  );
  assert.ok(
    wiredGuardCandidates.includes('scripts/indirect-rules.mjs'),
    'wiring through pnpm run indirection counts'
  );
  assert.ok(!guardCandidates.includes('scripts/build-report.mjs'));
  assert.ok(wiredGuardCandidates.includes('scripts/oddly-named-rules.mjs'));
  assert.ok(!wiredGuardCandidates.includes('scripts/verify-imports.mjs'));
});

test('requires an explicit full sweep when no watermark is supplied', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const missingMode = collect(fixture, []);
  assert.equal(missingMode.status, 1);
  assert.match(missingMode.stderr, /provide exactly one/u);

  write(fixture.repo, 'AGENTS.md', 'DIRTY CHECKOUT NEVER becomes policy evidence.\n');
  const fullSweep = collect(fixture, ['--full-sweep']);
  assert.equal(fullSweep.status, 0, fullSweep.stderr);
  const evidence = JSON.parse(fullSweep.stdout);
  assert.equal(evidence.delta.mode, 'full-sweep');
  assert.ok(evidence.delta.files.includes('AGENTS.md'));
  assert.ok(
    evidence.invariantStatements.some(
      (statement) => statement.text === 'Capabilities MUST fail visibly.'
    )
  );
  assert.ok(
    evidence.invariantStatements.every((statement) => !statement.text.includes('DIRTY CHECKOUT'))
  );
});

test('rejects a watermark that is not an ancestor of origin/main', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  run('git', ['checkout', '--orphan', 'unrelated'], fixture.repo);
  run('git', ['add', '.'], fixture.repo);
  run('git', ['commit', '-m', 'unrelated'], fixture.repo);
  const unrelated = run('git', ['rev-parse', 'HEAD'], fixture.repo);

  const result = collect(fixture, ['--watermark', unrelated]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not an ancestor of origin\/main/u);
});

test('emits evidence and exits two for multiple open Axiom PRs', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const pullRequests = [1, 2].map((number) => ({
    baseRefName: 'main',
    headRefName: `night-shift/axiom/example-${number}`,
    headRefOid: fixture.head,
    isDraft: false,
    number,
    title: `Axiom ${number}`,
    url: `https://github.com/example/brainstrike/pull/${number}`,
  }));

  const result = collect(fixture, ['--watermark', fixture.watermark], pullRequests);
  assert.equal(result.status, 2, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.protocolViolations[0].code, 'multiple-open-axiom-prs');
  assert.deepEqual(evidence.protocolViolations[0].pullRequests, [1, 2]);
});
