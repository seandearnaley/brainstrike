import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  isUnitTestFile,
  parseChangedUnitTestArgs,
  planChangedWorkspaceUnitTests,
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
          '--coverage.enabled=false',
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
          '--coverage.enabled=false',
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
      runner: async (command, args, options) => {
        calls.push({ args, command, env: options.env });
        return '';
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      {
        args: [
          'turbo',
          'run',
          'build',
          '--filter',
          '@brainstrike/utils^...',
          '--concurrency=16',
          '--summarize',
          '--log-order=grouped',
          '--cache-dir=.turbo',
        ],
        command: 'pnpm',
        env: {
          CI: 'false',
          COVERAGE: 'false',
          TURBO_TEST_MODE: 'unit',
        },
      },
      {
        args: [
          '--filter',
          '@brainstrike/utils',
          'exec',
          'vitest',
          'run',
          '--coverage.enabled=false',
          'src/__tests__/token-counting-boundary.test.ts',
        ],
        command: 'pnpm',
        env: {
          CI: 'false',
          COVERAGE: 'false',
          TURBO_TEST_MODE: 'unit',
        },
      },
    ]);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('planChangedWorkspaceUnitTests runs changed tests instead of full workspace when tests changed', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'brainstrike-changed-unit-'));
  try {
    await writePackage(rootDir, 'packages/ui', '@brainstrike/ui');
    await writePackage(rootDir, 'apps/desktop', '@brainstrike/desktop');

    const commands = await planChangedWorkspaceUnitTests(
      [
        'packages/ui/src/code-surface/code-surface.tsx',
        'packages/ui/src/__tests__/code-surface.test.tsx',
        'apps/desktop/src/ipc-embedding-backfill.ts',
        'apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts',
      ],
      { cwd: rootDir }
    );

    assert.deepEqual(commands, [
      {
        args: [
          '--filter',
          '@brainstrike/desktop',
          'exec',
          'vitest',
          'run',
          '--coverage.enabled=false',
          'src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts',
        ],
        command: 'pnpm',
        files: ['src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts'],
        owner: '@brainstrike/desktop',
        workspaceRoot: 'apps/desktop',
      },
      {
        args: [
          '--filter',
          '@brainstrike/ui',
          'exec',
          'vitest',
          'run',
          '--coverage.enabled=false',
          'src/__tests__/code-surface.test.tsx',
        ],
        command: 'pnpm',
        files: ['src/__tests__/code-surface.test.tsx'],
        owner: '@brainstrike/ui',
        workspaceRoot: 'packages/ui',
      },
    ]);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('planChangedWorkspaceUnitTests runs full workspace tests for source-only changes', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'brainstrike-changed-unit-'));
  try {
    await writePackage(rootDir, 'packages/ui', '@brainstrike/ui');
    await writePackage(rootDir, 'packages/file-explorer-ui', '@brainstrike/file-explorer-ui');

    const commands = await planChangedWorkspaceUnitTests(
      [
        'packages/ui/src/code-surface/language.ts',
        'packages/file-explorer-ui/e2e/layout-persistence.test.ts',
        'docs/architecture-reset/handoff.md',
      ],
      { cwd: rootDir }
    );

    assert.deepEqual(commands, [
      {
        args: ['--filter', '@brainstrike/ui', 'test'],
        command: 'pnpm',
        files: [],
        owner: '@brainstrike/ui',
        workspaceRoot: 'packages/ui',
      },
    ]);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('parseChangedUnitTestArgs fails closed without a base ref', () => {
  assert.throws(() => parseChangedUnitTestArgs([]), /--base is required/);
});
