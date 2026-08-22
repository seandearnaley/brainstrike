import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  contractPathForEntry,
  loadRepositoryContract,
  parseGuardInventory,
  validateGuardInventory,
  validateRequiredRunner,
} from '../verify-guard-inventory.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = fileURLToPath(new URL('../verify-guard-inventory.mjs', import.meta.url));
const requiredStaticCondition =
  "always() && (needs.admission.result != 'success' || needs.admission.outputs.admitted == 'true')";
const canonicalPackageScripts = {
  'test:scripts': 'node scripts/run-script-contracts.mjs',
};

function workflowSource({
  jobCondition = requiredStaticCondition,
  jobContinueOnError,
  runnerContinueOnError,
  runnerCondition,
  runnerCommand = 'pnpm test:scripts',
} = {}) {
  const lines = ['jobs:', '  static:', `    if: ${jobCondition}`];
  if (jobContinueOnError !== undefined) {
    lines.push(`    continue-on-error: ${jobContinueOnError}`);
  }
  lines.push('    steps:', `      - run: ${runnerCommand}`);
  if (runnerCondition !== undefined) {
    lines.push(`        if: ${runnerCondition}`);
  }
  if (runnerContinueOnError !== undefined) {
    lines.push(`        continue-on-error: ${runnerContinueOnError}`);
  }
  return lines.join('\n');
}

test('parses the authoritative classified guard set', () => {
  const entries = parseGuardInventory(
    'example-guard.mjs → wired/paired/armed → protects an example invariant\n'
  );

  assert.deepEqual(entries, [
    {
      purpose: 'protects an example invariant',
      script: 'example-guard.mjs',
      states: ['wired', 'paired', 'armed'],
    },
  ]);
  assert.equal(contractPathForEntry(entries[0]), 'scripts/__tests__/example-guard.test.mjs');
});

test('uses an explicit contract path from the inventory row', () => {
  const [entry] = parseGuardInventory(
    'example-guard.mjs → wired/paired/armed → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n'
  );

  assert.equal(contractPathForEntry(entry), 'scripts/__tests__/different-contract.test.mjs');
});

test('rejects malformed and duplicate classified guard rows', () => {
  assert.throws(
    () => parseGuardInventory('not an inventory row\n'),
    /scripts\/_guard-inventory\.md:1 must match/
  );
  assert.throws(
    () =>
      parseGuardInventory(
        [
          'example-guard.mjs → wired/paired/armed → first purpose',
          'example-guard.mjs → wired/paired/armed → second purpose',
        ].join('\n')
      ),
    /duplicate guard example-guard\.mjs/
  );
});

test('rejects a statically disabled required Static job', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({ jobCondition: 'false' }),
  });

  assert.deepEqual(issues, [
    'required Static job must retain the admission-gated execution condition',
  ]);
});

test('rejects shell-comment text in place of the canonical runner', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: [
      'jobs:',
      '  static:',
      `    if: ${requiredStaticCondition}`,
      '    steps:',
      '      - run: |',
      '          echo no-tests',
      '          # pnpm test:scripts',
    ].join('\n'),
  });

  assert.deepEqual(issues, [
    'required Static job must invoke exactly one unconditional "pnpm test:scripts" step',
  ]);
});

test('rejects a non-blocking canonical runner step', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({ runnerContinueOnError: true }),
  });

  assert.deepEqual(issues, ['required Static runner must be unconditional and blocking']);
});

test('rejects a non-blocking required Static job', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({ jobContinueOnError: true }),
  });

  assert.deepEqual(issues, ['required Static runner must be unconditional and blocking']);
});

test('rejects an expression-valued continue-on-error runner step', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({
      runnerContinueOnError: ['$', '{{ true }}'].join(''),
    }),
  });

  assert.deepEqual(issues, ['required Static runner must be unconditional and blocking']);
});

test('rejects a quoted continue-on-error required Static job', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({ jobContinueOnError: '"true"' }),
  });

  assert.deepEqual(issues, ['required Static runner must be unconditional and blocking']);
});

test('rejects a conditional canonical runner step', () => {
  const issues = validateRequiredRunner({
    packageScripts: canonicalPackageScripts,
    workflowSource: workflowSource({ runnerCondition: 'false' }),
  });

  assert.deepEqual(issues, ['required Static runner must be unconditional and blocking']);
});

test('rejects a package script that bypasses the canonical contract runner', () => {
  const issues = validateRequiredRunner({
    packageScripts: { 'test:scripts': 'node --test scripts/__tests__/*.test.mjs' },
    workflowSource: workflowSource(),
  });

  assert.deepEqual(issues, [
    'test:scripts must execute the canonical scripts/run-script-contracts.mjs runner',
  ]);
});

test('rejects missing guard and contract files', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-'));
  try {
    const scriptsRoot = path.join(workspace, 'scripts');
    await mkdir(path.join(scriptsRoot, '__tests__'), { recursive: true });

    const issues = await validateGuardInventory({
      inventorySource: 'missing-guard.mjs → wired/paired/armed → protects a missing invariant\n',
      packageScripts: canonicalPackageScripts,
      repoRoot: workspace,
      scriptsRoot,
      testPaths: [],
      workflowSource: workflowSource(),
    });

    assert.deepEqual(issues, [
      'missing-guard.mjs: classified guard script does not exist',
      'missing-guard.mjs: paired contract scripts/__tests__/missing-guard.test.mjs is not discoverable',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('validates the current classified guard inventory', async () => {
  const contract = await loadRepositoryContract(repoRoot);
  assert.deepEqual(contract.issues, []);
});

async function createBrokenFixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-cli-'));
  const scriptsRoot = path.join(workspace, 'scripts');
  await mkdir(path.join(scriptsRoot, '__tests__'), { recursive: true });
  await mkdir(path.join(workspace, '.github', 'workflows'), { recursive: true });
  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ scripts: canonicalPackageScripts })
  );
  await writeFile(path.join(workspace, '.github', 'workflows', 'test.yml'), workflowSource());
  await writeFile(
    path.join(scriptsRoot, '_guard-inventory.md'),
    'missing-guard.mjs → wired/paired/armed → protects a missing invariant\n'
  );
  await writeFile(
    path.join(scriptsRoot, '__tests__', 'missing-guard.test.mjs'),
    "import test from 'node:test';\ntest('negative control', () => {});\n"
  );
  return workspace;
}

test('direct execution is an armed fail-closed guard', async () => {
  const workspace = await createBrokenFixture();
  try {
    const result = spawnSync(process.execPath, [scriptPath, workspace], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Warden guard inventory verification failed/);
    assert.match(result.stderr, /missing-guard\.mjs: classified guard script does not exist/);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('symlinked direct execution still runs the fail-closed guard', async () => {
  const workspace = await createBrokenFixture();
  try {
    const symlinkPath = path.join(workspace, 'verify-guard-inventory-link.mjs');
    await symlink(scriptPath, symlinkPath);
    const result = spawnSync(process.execPath, [symlinkPath, workspace], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Warden guard inventory verification failed/);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('current inventory file remains readable as UTF-8 contract data', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts', '_guard-inventory.md'), 'utf8');
  assert.ok(source.includes('verify-guard-inventory.mjs → wired/paired/armed'));
});
