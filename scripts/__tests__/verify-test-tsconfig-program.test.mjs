import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyTestTsconfigProgram } from '../verify-test-tsconfig-program.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

test('rejects a program whose roots contain no test files', async () => {
  const root = await writeFixture({
    source: 'export const value = 1;\n',
    tsconfig: { compilerOptions: { strict: true }, files: ['src/example.test.ts'] },
  });
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ files: ['src/not-a-test.ts'] })
  );
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
