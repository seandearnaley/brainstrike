import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  isUnitTestFile,
  parseChangedUnitTestArgs,
  planChangedUnitTests,
  runChangedUnitTests,
} from '../run-changed-unit-tests.mjs';

async function writePackage(rootDir, workspaceRoot, name) {
  const packageDir = path.join(rootDir, workspaceRoot);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      scripts: {
        test: 'vitest run',
      },
    })
  );
}

test('isUnitTestFile accepts app and package unit tests but rejects e2e specs', () => {
  assert.equal(isUnitTestFile('packages/utils/src/__tests__/token.test.ts'), true);
  assert.equal(isUnitTestFile('apps/web/src/app/page.test.tsx'), true);
  assert.equal(isUnitTestFile('packages/db/src/foo.integration.test.ts'), true);
  assert.equal(isUnitTestFile('apps/web/e2e/layout-persistence.test.ts'), false);
  assert.equal(isUnitTestFile('scripts/__tests__/ci-select.test.mjs'), false);
});

test('planChangedUnitTests groups changed unit tests by owning workspace', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'brainstrike-changed-unit-'));
  try {
    await writePackage(rootDir, 'packages/utils', '@brainstrike/utils');
    await writePackage(rootDir, 'apps/web', '@brainstrike/web');

    const commands = await planChangedUnitTests(
      [
        'packages/utils/src/__tests__/second.test.ts',
        'apps/web/src/app/root-layout-content.test.tsx',
        'packages/utils/src/__tests__/first.test.ts',
        'apps/web/e2e/layout-persistence.test.ts',
      ],
      { cwd: rootDir }
    );

    assert.deepEqual(commands, [
      {
        args: [
          '--filter',
          '@brainstrike/web',
          'exec',
          'vitest',
          'run',
          'src/app/root-layout-content.test.tsx',
        ],
        command: 'pnpm',
        files: ['src/app/root-layout-content.test.tsx'],
        owner: '@brainstrike/web',
        workspaceRoot: 'apps/web',
      },
      {
        args: [
          '--filter',
          '@brainstrike/utils',
          'exec',
          'vitest',
          'run',
          'src/__tests__/first.test.ts',
          'src/__tests__/second.test.ts',
        ],
        command: 'pnpm',
        files: ['src/__tests__/first.test.ts', 'src/__tests__/second.test.ts'],
        owner: '@brainstrike/utils',
        workspaceRoot: 'packages/utils',
      },
    ]);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runChangedUnitTests executes only the selected workspace unit commands', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'brainstrike-changed-unit-'));
  const calls = [];
  try {
    await writePackage(rootDir, 'packages/utils', '@brainstrike/utils');
    const exitCode = await runChangedUnitTests({
      cwd: rootDir,
      files: ['packages/utils/src/__tests__/token-counting-boundary.test.ts'],
      runner: async (command, args) => {
        calls.push({ args, command });
        return '';
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      {
        args: [
          '--filter',
          '@brainstrike/utils',
          'exec',
          'vitest',
          'run',
          'src/__tests__/token-counting-boundary.test.ts',
        ],
        command: 'pnpm',
      },
    ]);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('parseChangedUnitTestArgs fails closed without a base ref', () => {
  assert.throws(() => parseChangedUnitTestArgs([]), /--base is required/);
});
