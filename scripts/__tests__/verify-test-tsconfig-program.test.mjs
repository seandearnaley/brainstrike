import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { verifyTestTsconfigProgram } from '../verify-test-tsconfig-program.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readJsonc(filePath) {
  const parsed = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, 'utf8'));
  assert.equal(parsed.error, undefined, `Could not parse ${filePath}`);
  return parsed.config;
}

async function writeFixture({ source, tsconfig }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-tsconfig-program-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/example.test.ts'), source);
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  return root;
}

test('real desktop test program clears its anti-vacuity floor', () => {
  const result = verifyTestTsconfigProgram({
    checkTypes: false,
    cwd: path.join(repoRoot, 'apps/desktop'),
    minTestFiles: 400,
    project: 'tsconfig.test.json',
  });

  assert.equal(result.ok, true, result.message);
  assert.ok(result.testFiles.length >= 400);
});

test('desktop type-check hashes the root anti-vacuity verifier', () => {
  const turboConfig = readJsonc(path.join(repoRoot, 'apps/desktop/turbo.json'));
  const inputs = turboConfig.tasks?.['type-check']?.inputs;

  assert.ok(Array.isArray(inputs), 'desktop turbo.json must override type-check inputs');
  assert.ok(inputs.includes('$TURBO_DEFAULT$'), 'desktop type-check must retain default inputs');
  assert.ok(
    inputs.includes('$TURBO_ROOT$/scripts/verify-test-tsconfig-program.mjs'),
    'desktop type-check must hash scripts/verify-test-tsconfig-program.mjs'
  );
});

test('desktop type-check:test remains wired through the verifier and production floor', () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'apps/desktop/package.json')));
  const command = manifest.scripts?.['type-check:test'];

  assert.equal(typeof command, 'string');
  assert.match(command, /scripts\/verify-test-tsconfig-program\.mjs/u);
  assert.match(command, /--project tsconfig\.test\.json/u);
  const floor = command.match(/--min-test-files (\d+)/u);
  assert.ok(floor, 'desktop type-check:test must declare --min-test-files');
  assert.ok(Number(floor[1]) >= 400, 'desktop type-check:test floor must remain at least 400');
});

test('uses the compiler program file list rather than serialized showConfig roots', () => {
  const calls = [];
  const result = verifyTestTsconfigProgram({
    checkTypes: false,
    cwd: '/workspace/app',
    minTestFiles: 1,
    project: 'tsconfig.test.json',
    runTscCommand: (args) => {
      calls.push(args);
      return {
        error: undefined,
        status: 0,
        stderr: '',
        stdout: '/workspace/app/src/example.test.ts\n/workspace/app/src/index.ts\n',
      };
    },
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(calls, [['--listFilesOnly', '--project', '/workspace/app/tsconfig.test.json']]);
  assert.deepEqual(result.testFiles, ['/workspace/app/src/example.test.ts']);
});

test('surfaces a tsc spawn failure instead of misreporting a diagnostic rejection', () => {
  const result = verifyTestTsconfigProgram({
    cwd: '/workspace/app',
    minTestFiles: 1,
    project: 'tsconfig.test.json',
    runTscCommand: () => ({
      error: new Error('spawn pnpm ENOENT'),
      status: null,
      stderr: '',
      stdout: '',
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Unable to run tsc/u);
  assert.match(result.message, /spawn pnpm ENOENT/u);
});

test('rejects a program whose roots contain no test files', async () => {
  const root = await writeFixture({
    source: 'export const value = 1;\n',
    tsconfig: { files: ['src/not-a-test.ts'] },
  });
  await writeFile(path.join(root, 'src/not-a-test.ts'), 'export const value = 1;\n');

  const result = verifyTestTsconfigProgram({
    cwd: root,
    minTestFiles: 1,
    project: 'tsconfig.json',
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /selected 0 test files; expected at least 1/u);
});

test('money test: a broken test-only import fails with the compiler diagnostic', async () => {
  const root = await writeFixture({
    source: "import { missing } from './does-not-exist';\nexport { missing };\n",
    tsconfig: {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
      files: ['src/example.test.ts'],
    },
  });

  const result = verifyTestTsconfigProgram({
    cwd: root,
    minTestFiles: 1,
    project: 'tsconfig.json',
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /TS2307/u);
  assert.match(result.message, /does-not-exist/u);
});

test('accepts a non-vacuous type-correct test program', async () => {
  const root = await writeFixture({
    source: 'export const value: number = 1;\n',
    tsconfig: { compilerOptions: { strict: true }, files: ['src/example.test.ts'] },
  });

  const result = verifyTestTsconfigProgram({
    cwd: root,
    minTestFiles: 1,
    project: 'tsconfig.json',
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.testFiles.length, 1);
});
