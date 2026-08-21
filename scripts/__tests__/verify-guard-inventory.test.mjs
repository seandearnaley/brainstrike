import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadGuardTestSources,
  parseGuardInventory,
  validateGuardInventory,
} from '../verify-guard-inventory.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const inventoryPath = path.join(repoRoot, 'scripts', '_guard-inventory.md');
const scriptPath = fileURLToPath(new URL('../verify-guard-inventory.mjs', import.meta.url));

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
});

test('rejects malformed and duplicate classified guard rows', () => {
  assert.throws(
    () => parseGuardInventory('not an inventory row\n'),
    /scripts\/_guard-inventory\.md:1 must match/
  );
  assert.doesNotThrow(() =>
    parseGuardInventory('example-guard.cjs → wired/paired/armed → protects an example invariant\n')
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

test('rejects classified rows whose guard script no longer exists', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-'));
  try {
    const issues = await validateGuardInventory({
      inventorySource: 'missing-guard.mjs → wired/paired/armed → protects a missing invariant\n',
      packageScripts: {},
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'missing-guard.test.mjs',
          source: "import '../missing-guard.mjs';",
        },
      ],
    });

    assert.deepEqual(issues, ['missing-guard.mjs: classified guard script does not exist']);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects required lint guards omitted from the inventory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-required-guard-'));
  try {
    await Promise.all(
      ['declared-guard.mjs', 'omitted-guard.mjs'].map((script) =>
        writeFile(path.join(workspace, script), 'export {};\n')
      )
    );

    const issues = await validateGuardInventory({
      inventorySource: 'declared-guard.mjs → wired/paired/armed → protects a declared invariant\n',
      packageScripts: {
        lint: 'pnpm run lint:omitted',
        'lint:omitted': 'node scripts/omitted-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'declared-guard.test.mjs',
          source: "import '../declared-guard.mjs';",
        },
      ],
    });

    assert.deepEqual(issues, [
      'omitted-guard.mjs: required root guard script is missing from scripts/_guard-inventory.md',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects paired claims without discoverable test evidence', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-paired-guard-'));
  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource: 'example-guard.mjs → wired/paired/armed → protects an example invariant\n',
      packageScripts: {},
      scriptsRoot: workspace,
      testSources: [],
    });

    assert.deepEqual(issues, [
      'example-guard.mjs: paired guard has no discoverable test under scripts/__tests__',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('validates the current classified guard inventory', async () => {
  const inventorySource = await readFile(inventoryPath, 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const issues = await validateGuardInventory({
    inventorySource,
    packageScripts: packageJson.scripts,
    scriptsRoot: path.join(repoRoot, 'scripts'),
    testSources: await loadGuardTestSources(path.join(repoRoot, 'scripts')),
  });

  assert.deepEqual(issues, []);
});

test('direct execution is an armed fail-closed guard', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-cli-'));
  try {
    const scriptsRoot = path.join(workspace, 'scripts');
    await mkdir(path.join(scriptsRoot, '__tests__'), { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), '{"scripts":{}}\n');
    await writeFile(
      path.join(scriptsRoot, '_guard-inventory.md'),
      'missing-guard.mjs → wired/paired/armed → protects a missing invariant\n'
    );
    await writeFile(
      path.join(scriptsRoot, '__tests__', 'missing-guard.test.mjs'),
      "import '../missing-guard.mjs';\n"
    );

    const result = spawnSync(process.execPath, [scriptPath, workspace], {
      cwd: workspace,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Warden guard inventory verification failed/);
    assert.match(result.stderr, /missing-guard\.mjs: classified guard script does not exist/);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('the verifier is wired into the Static lint path', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(
    packageJson.scripts['lint:guard-inventory'],
    'node scripts/verify-guard-inventory.mjs'
  );
  assert.match(packageJson.scripts.lint, /pnpm run lint:guard-inventory/);
  assert.match(packageJson.scripts['lint:ci'], /pnpm run lint:guard-inventory/);
});
