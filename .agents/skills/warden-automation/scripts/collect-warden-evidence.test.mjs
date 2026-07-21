import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const collector = new URL('./collect-warden-evidence.mjs', import.meta.url).pathname;
const temporaryRoots = [];

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function createFixture({ includeInventory = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'warden-skill-'));
  temporaryRoots.push(root);
  write(root, 'AGENTS.md', '# Rules\n');
  write(root, 'docs/agents/ci-quality.md', '# CI\n');
  write(root, '.night-shift/PROTOCOL.md', '# Protocol\n');
  write(
    root,
    '.night-shift/charters/warden.md',
    'CHARTER_VERSION=7\nSTATE_ISSUE="[automation-state] Warden"\nInventory scripts/*.mjs and scripts/*.cjs plus scripts/__tests__/*.test.mjs.\nCap at 5 repairs per PR.\n'
  );
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        scripts: {
          'lint:ci': 'node scripts/good-guard.mjs',
          'test:scripts': 'node --test scripts/__tests__/*.test.mjs',
        },
      },
      null,
      2
    )
  );
  write(
    root,
    '.github/workflows/test.yml',
    'jobs:\n  static:\n    steps:\n      - run: pnpm --silent run lint:ci\n      - run: pnpm test:scripts\n'
  );
  write(
    root,
    'scripts/good-guard.mjs',
    "// Guard against bad fixtures.\nexport function findViolations(value) { return value === 'bad' ? ['bad'] : []; }\nif (findViolations('good').length) process.exit(1);\n"
  );
  write(
    root,
    'scripts/orphan-guard.mjs',
    '// Guard against orphan defects.\nif (false) process.exit(1);\n'
  );
  write(root, 'scripts/helper.mjs', 'export const helper = true;\n');
  write(
    root,
    'scripts/__tests__/good-guard.test.mjs',
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { findViolations } from '../good-guard.mjs';\ntest('flags deliberately bad fixture', () => assert.deepEqual(findViolations('bad'), ['bad']));\n"
  );
  if (includeInventory) {
    write(root, 'scripts/_guard-inventory.md', '# Guard inventory\n');
  }
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'warden@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Warden Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: root });
  return root;
}

test.after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('collects wiring, pairing, arming candidates, and history without making verdicts', () => {
  const root = createFixture();
  const output = JSON.parse(
    execFileSync('node', [collector, '--repo', root], { encoding: 'utf8' })
  );
  const good = output.inventory.scripts.find((entry) => entry.name === 'good-guard.mjs');
  const orphan = output.inventory.scripts.find((entry) => entry.name === 'orphan-guard.mjs');

  assert.equal(output.status, 'ok');
  assert.equal(output.charter.version, 7);
  assert.equal(output.charter.repairCap, 5);
  assert.equal(output.git.headMatchesOriginMain, true);
  assert.equal(output.preflight.status, 'local-evidence-ready');
  assert.deepEqual(output.ci.guardEntryFiles, ['scripts/good-guard.mjs']);
  assert.deepEqual(output.ci.testEntryFiles, ['scripts/__tests__/good-guard.test.mjs']);
  assert.equal(good.wiring.ciReachable, true);
  assert.equal(good.wiring.ciTestReachable, true);
  assert.deepEqual(good.wiring.ciReachableTests, ['scripts/__tests__/good-guard.test.mjs']);
  assert.equal(orphan.wiring.ciTestReachable, false);
  assert.equal(output.summary.ciTestReachableScriptCount, 1);
  assert.deepEqual(good.pairing.directTests, ['scripts/__tests__/good-guard.test.mjs']);
  assert.deepEqual(good.arming.negativeControlCandidates, [
    {
      test: 'scripts/__tests__/good-guard.test.mjs',
      title: 'flags deliberately bad fixture',
    },
  ]);
  assert.equal(good.classification, 'review-required');
  assert.equal(orphan.wiring.ciReachable, false);
  assert.deepEqual(orphan.pairing.directTests, []);
  assert.ok(orphan.history.length > 0);
});

test('does not count test-only reachability as guard wiring and surfaces preflight blockers', () => {
  const root = createFixture();
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  Reflect.deleteProperty(manifest.scripts, 'lint:ci');
  write(root, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write(
    root,
    '.github/workflows/test.yml',
    'jobs:\n  static:\n    steps:\n      - run: pnpm test:scripts\n'
  );
  rmSync(path.join(root, 'scripts', '_guard-inventory.md'));

  const output = JSON.parse(
    execFileSync('node', [collector, '--repo', root], { encoding: 'utf8' })
  );
  const good = output.inventory.scripts.find((entry) => entry.name === 'good-guard.mjs');

  assert.equal(output.status, 'blocked');
  assert.equal(good.wiring.ciReachable, false);
  assert.equal(good.wiring.ciTestReachable, true);
  assert.deepEqual(output.ci.guardEntryFiles, []);
  assert.deepEqual(output.preflight.blockers, ['working tree is dirty']);
  assert.deepEqual(output.preflight.firstRunEvidence, [
    'scripts/_guard-inventory.md does not exist yet; Warden creates it on the first run',
  ]);
});

test('reports a missing guard inventory as first-run evidence, not a bootstrap deadlock', () => {
  const root = createFixture({ includeInventory: false });
  const output = JSON.parse(
    execFileSync('node', [collector, '--repo', root], { encoding: 'utf8' })
  );

  assert.equal(output.status, 'ok');
  assert.equal(output.preflight.status, 'local-evidence-ready');
  assert.deepEqual(output.preflight.blockers, []);
  assert.equal(output.inventory.guardInventoryExists, false);
  assert.deepEqual(output.preflight.firstRunEvidence, [
    'scripts/_guard-inventory.md does not exist yet; Warden creates it on the first run',
  ]);
});

test('ignores commented-out workflow lines when tracing CI wiring', () => {
  const root = createFixture();
  write(
    root,
    '.github/workflows/test.yml',
    [
      'jobs:',
      '  static:',
      '    steps:',
      '      # - run: pnpm test:scripts',
      '      # - run: node scripts/orphan-guard.mjs',
      '      - run: pnpm run lint:ci',
      '',
    ].join('\n')
  );

  const output = JSON.parse(
    execFileSync('node', [collector, '--repo', root], { encoding: 'utf8' })
  );
  const good = output.inventory.scripts.find((entry) => entry.name === 'good-guard.mjs');
  const orphan = output.inventory.scripts.find((entry) => entry.name === 'orphan-guard.mjs');

  assert.ok(!output.ci.reachablePackageScripts.includes('test:scripts'));
  assert.deepEqual(output.ci.testEntryFiles, []);
  assert.equal(good.wiring.ciReachable, true);
  assert.equal(good.wiring.ciTestReachable, false);
  assert.equal(orphan.wiring.ciReachable, false);
  assert.deepEqual(orphan.wiring.workflowReferences, []);
});

test('fails closed when a required contract file is missing', () => {
  const root = createFixture();
  rmSync(path.join(root, '.night-shift', 'PROTOCOL.md'));
  const result = spawnSync('node', [collector, '--repo', root], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required file is missing: \.night-shift\/PROTOCOL\.md/);
});
