import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../enforce-coverage.mjs', import.meta.url));
let workspace;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-coverage-contract-'));
  await mkdir(path.join(workspace, 'apps'), { recursive: true });
  await mkdir(path.join(workspace, 'packages', 'instrumented', 'coverage'), {
    recursive: true,
  });
  await mkdir(path.join(workspace, 'packages', 'native'), { recursive: true });

  await writeFile(
    path.join(workspace, 'packages', 'instrumented', 'package.json'),
    JSON.stringify({
      name: '@brainstrike/instrumented',
      scripts: { 'test:coverage': 'vitest run --coverage' },
    })
  );
  await writeFile(
    path.join(workspace, 'packages', 'instrumented', 'coverage', 'coverage-final.json'),
    JSON.stringify({
      'source.ts': {
        b: {},
        branchMap: {},
        f: {},
        fnMap: {},
        path: 'source.ts',
        s: {},
        statementMap: {},
      },
    })
  );
  await writeFile(
    path.join(workspace, 'packages', 'native', 'package.json'),
    JSON.stringify({
      name: '@brainstrike/native',
      scripts: { 'test:coverage': 'pnpm test' },
    })
  );
});

after(async () => {
  await rm(workspace, { force: true, recursive: true });
});

test('requires artifacts only from instrumented coverage scripts', () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: workspace,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All package coverage thresholds satisfied\./);
});

test('still fails closed when an instrumented coverage script has no artifact', async () => {
  await mkdir(path.join(workspace, 'packages', 'missing'), { recursive: true });
  await writeFile(
    path.join(workspace, 'packages', 'missing', 'package.json'),
    JSON.stringify({
      name: '@brainstrike/missing',
      scripts: { 'test:coverage': 'vitest run --coverage' },
    })
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: workspace,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing coverage artifacts for coverage-producing test:coverage scripts/
  );
  assert.match(result.stderr, /@brainstrike\/missing/);
});
