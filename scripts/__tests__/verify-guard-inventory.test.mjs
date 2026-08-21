import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant\n'
  );

  assert.deepEqual(entries, [
    {
      purpose: 'protects an example invariant',
      script: 'example-guard.mjs',
      states: { armed: true, paired: true, wired: true },
    },
  ]);
});

test('rejects malformed and duplicate classified guard rows', () => {
  assert.throws(
    () => parseGuardInventory('not an inventory row\n'),
    /scripts\/_guard-inventory\.md:1 must match/
  );
  assert.doesNotThrow(() =>
    parseGuardInventory(
      'example-guard.cjs → wired=yes/paired=yes/armed=yes → protects an example invariant\n'
    )
  );
  assert.throws(
    () =>
      parseGuardInventory(
        [
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → first purpose',
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → second purpose',
        ].join('\n')
      ),
    /duplicate guard example-guard\.mjs/
  );
});

test('preserves classified guards with degraded states and reports every gap', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-degraded-guard-'));
  const source =
    'example-guard.mjs → wired=yes/paired=no/armed=no → protects an example invariant\n';

  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');
    const entries = parseGuardInventory(source);

    assert.deepEqual(entries[0]?.states, {
      armed: false,
      paired: false,
      wired: true,
    });
    assert.deepEqual(
      await validateGuardInventory({
        inventorySource: source,
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [],
      }),
      ['example-guard.mjs: degraded guard state (paired=no, armed=no)']
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects classified rows whose guard script no longer exists', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-'));
  try {
    const issues = await validateGuardInventory({
      inventorySource:
        'missing-guard.mjs → wired=yes/paired=yes/armed=yes → protects a missing invariant\n',
      packageScripts: {},
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'missing-guard.test.mjs',
          source: "import { main } from '../missing-guard.mjs';\nmain();",
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
      inventorySource:
        'declared-guard.mjs → wired=yes/paired=yes/armed=yes → protects a declared invariant\n',
      packageScripts: {
        lint: 'pnpm run lint:omitted',
        'lint:omitted': 'node scripts/omitted-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'declared-guard.test.mjs',
          source: "import { main } from '../declared-guard.mjs';\nmain();",
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

test('rejects a wired guard leaf that is unreachable from required entrypoints', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-unreachable-guard-'));
  try {
    await writeFile(path.join(workspace, 'orphaned-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource:
        'orphaned-guard.mjs → wired=yes/paired=yes/armed=yes → protects an orphaned invariant\n',
      packageScripts: {
        lint: 'biome check .',
        'lint:ci': 'biome check .',
        'lint:orphaned': 'node scripts/orphaned-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'orphaned-guard.test.mjs',
          source: "import { main } from '../orphaned-guard.mjs';\nmain();\n",
        },
      ],
    });

    assert.deepEqual(issues, [
      'orphaned-guard.mjs: wired guard leaf is not reachable from a required root entrypoint',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects a required-path channel reachable only through local lint', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-unbound-required-guard-'));
  try {
    await writeFile(path.join(workspace, 'orphaned-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource:
        'orphaned-guard.mjs → wired=yes/paired=yes/armed=yes → protects an orphaned invariant; channel: required-path\n',
      packageScripts: {
        lint: 'pnpm run lint:orphaned',
        'lint:ci': 'biome check .',
        'lint:orphaned': 'node scripts/orphaned-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'orphaned-guard.test.mjs',
          source: "import { main } from '../orphaned-guard.mjs';\nmain();\n",
        },
      ],
      workflowSources: ['jobs:\n  static:\n    steps:\n      - run: pnpm run lint:ci\n'],
    });

    assert.deepEqual(issues, [
      'orphaned-guard.mjs: declared required-path channel is not reachable from a required CI workflow',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects required workflow guards omitted from the inventory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-workflow-guard-'));
  try {
    await Promise.all(
      ['declared-guard.mjs', 'workflow-guard.mjs'].map((script) =>
        writeFile(path.join(workspace, script), 'export {};\n')
      )
    );

    const issues = await validateGuardInventory({
      inventorySource:
        'declared-guard.mjs → wired=yes/paired=yes/armed=yes → protects a declared invariant\n',
      packageScripts: { 'lint:ci': 'biome check .' },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'declared-guard.test.mjs',
          source: "import { main } from '../declared-guard.mjs';\nmain();\n",
        },
      ],
      workflowSources: [
        [
          '# node scripts/comment-only-guard.mjs',
          'jobs:',
          '  static:',
          '    steps:',
          '      - run: pnpm run lint:ci',
          '      - run: node scripts/workflow-guard.mjs',
        ].join('\n'),
      ],
    });

    assert.deepEqual(issues, [
      'workflow-guard.mjs: required root guard script is missing from scripts/_guard-inventory.md',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('rejects a required CI lint entrypoint that the workflow no longer reaches', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-workflow-entrypoint-'));
  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource:
        'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant\n',
      packageScripts: {
        lint: 'pnpm run lint:example',
        'lint:ci': 'pnpm run lint:example',
        'lint:example': 'node scripts/example-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'example-guard.test.mjs',
          source: "import { main } from '../example-guard.mjs';\nmain();\n",
        },
      ],
      workflowSources: ['jobs:\n  static:\n    steps:\n      - run: pnpm run secrets:scan\n'],
    });

    assert.deepEqual(issues, [
      'lint:ci: required package-script entrypoint is not reachable from required workflow commands',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('ignores non-Static jobs and inline comments when deriving CI reachability', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-static-workflow-'));
  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource: 'example-guard.mjs → wired/paired/armed → protects an example invariant\n',
      packageScripts: {
        lint: 'pnpm run lint:example',
        'lint:ci': 'pnpm run lint:example',
        'lint:example': 'node scripts/example-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'example-guard.test.mjs',
          source: "import { main } from '../example-guard.mjs';\nmain();\n",
        },
      ],
      workflowSources: [
        [
          'jobs:',
          '  static:',
          '    steps:',
          '      - run: echo no-lint # pnpm run lint:ci',
          '  unrelated:',
          '    steps:',
          '      - run: pnpm run lint:ci',
        ].join('\n'),
      ],
    });

    assert.deepEqual(issues, [
      'lint:ci: required package-script entrypoint is not reachable from required workflow commands',
    ]);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('ignores statically disabled Static steps when deriving CI reachability', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-disabled-static-step-'));
  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');

    const issues = await validateGuardInventory({
      inventorySource: 'example-guard.mjs → wired/paired/armed → protects an example invariant\n',
      packageScripts: {
        lint: 'pnpm run lint:example',
        'lint:ci': 'pnpm run lint:example',
        'lint:example': 'node scripts/example-guard.mjs',
      },
      scriptsRoot: workspace,
      testSources: [
        {
          path: 'example-guard.test.mjs',
          source: "import { main } from '../example-guard.mjs';\nmain();\n",
        },
      ],
      workflowSources: [
        [
          'jobs:',
          '  static:',
          '    steps:',
          ['      - if: $', '{{ false }}'].join(''),
          '        run: pnpm run lint:ci',
        ].join('\n'),
      ],
    });

    assert.deepEqual(issues, [
      'lint:ci: required package-script entrypoint is not reachable from required workflow commands',
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
      inventorySource:
        'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant\n',
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

test('requires an exact basename or declared contract path for paired evidence', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-explicit-guard-test-'));
  try {
    await writeFile(path.join(workspace, 'example-guard.mjs'), 'export {};\n');
    const testSources = [
      {
        path: 'different-contract.test.mjs',
        source: '// example-guard.mjs is mentioned only in prose\n',
      },
    ];

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources,
      }),
      ['example-guard.mjs: paired guard has no discoverable test under scripts/__tests__']
    );

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [
          {
            path: 'different-contract.test.mjs',
            source: [
              "import('../unrelated.mjs');",
              "import '../example-guard.mjs';",
              `const fixture = "import('../example-guard.mjs')";`,
              "run(); // 'scripts/example-guard.mjs'",
              "run(/* 'scripts/example-guard.mjs' */);",
              "writeFile('fixture.txt', 'scripts/example-guard.mjs');",
              "path.join('/unrelated/fixtures', 'example-guard.mjs');",
            ].join('\n'),
          },
        ],
      }),
      ['example-guard.mjs: paired guard has no discoverable test under scripts/__tests__']
    );

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [
          {
            path: 'different-contract.test.mjs',
            source: "import { main } from '../example-guard.mjs';\nmain();\n",
          },
        ],
      }),
      []
    );

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [
          {
            path: 'different-contract.test.mjs',
            source: [
              "import assert from 'node:assert/strict';",
              "import { spawnSync } from 'node:child_process';",
              "import { fileURLToPath } from 'node:url';",
              "const scriptPath = fileURLToPath(new URL('../example-guard.mjs', import.meta.url));",
              "const result = spawnSync(process.execPath, ['-e', 'process.exit(1)', scriptPath]);",
              'assert.equal(result.status, 1);',
            ].join('\n'),
          },
        ],
      }),
      ['example-guard.mjs: paired guard has no discoverable test under scripts/__tests__']
    );

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired/paired/armed → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [
          {
            path: 'different-contract.test.mjs',
            source: [
              "import assert from 'node:assert/strict';",
              "import { spawnSync } from 'node:child_process';",
              "import { fileURLToPath } from 'node:url';",
              "const scriptPath = fileURLToPath(new URL('../example-guard.mjs', import.meta.url));",
              'const result = spawnSync(process.execPath, [scriptPath]);',
              'assert.equal(result.status, 1);',
            ].join('\n'),
          },
        ],
      }),
      []
    );

    assert.deepEqual(
      await validateGuardInventory({
        inventorySource:
          'example-guard.mjs → wired=yes/paired=yes/armed=yes → protects an example invariant; contract: scripts/__tests__/different-contract.test.mjs\n',
        packageScripts: {},
        scriptsRoot: workspace,
        testSources: [
          {
            path: 'different-contract.test.mjs',
            source: [
              "import { spawnSync } from 'node:child_process';",
              "import { fileURLToPath } from 'node:url';",
              "const scriptPath = fileURLToPath(new URL('../example-guard.mjs', import.meta.url));",
              'spawnSync(process.execPath, [scriptPath]);',
            ].join('\n'),
          },
        ],
      }),
      ['example-guard.mjs: paired guard has no discoverable test under scripts/__tests__']
    );
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
    workflowSources: [
      await readFile(path.join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf8'),
    ],
  });

  assert.deepEqual(issues, []);
});

test('direct execution is an armed fail-closed guard', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-cli-'));
  try {
    const scriptsRoot = path.join(workspace, 'scripts');
    await mkdir(path.join(scriptsRoot, '__tests__'), { recursive: true });
    await mkdir(path.join(workspace, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), '{"scripts":{}}\n');
    await writeFile(
      path.join(workspace, '.github', 'workflows', 'test.yml'),
      'jobs:\n  static:\n    steps: []\n'
    );
    await writeFile(
      path.join(scriptsRoot, '_guard-inventory.md'),
      'missing-guard.mjs → wired=yes/paired=yes/armed=yes → protects a missing invariant\n'
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

test('direct execution remains armed through a symlink', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-guard-inventory-symlink-'));
  try {
    const scriptsRoot = path.join(workspace, 'scripts');
    const symlinkPath = path.join(workspace, 'verify-guard-inventory-link.mjs');
    await mkdir(path.join(scriptsRoot, '__tests__'), { recursive: true });
    await mkdir(path.join(workspace, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), '{"scripts":{}}\n');
    await writeFile(
      path.join(workspace, '.github', 'workflows', 'test.yml'),
      'jobs:\n  static:\n    steps: []\n'
    );
    await writeFile(
      path.join(scriptsRoot, '_guard-inventory.md'),
      'missing-guard.mjs → wired/paired/armed → protects a missing invariant\n'
    );
    await writeFile(
      path.join(scriptsRoot, '__tests__', 'missing-guard.test.mjs'),
      "import { main } from '../missing-guard.mjs';\nmain();\n"
    );
    await symlink(scriptPath, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath, workspace], {
      cwd: workspace,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Warden guard inventory verification failed/);
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
