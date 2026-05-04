import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { prepareWorkspaceCoverage } from '../prepare-workspace-coverage.mjs';

function fileCoverage(filePath, hits) {
  return {
    [filePath]: {
      path: filePath,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      },
      s: { 0: hits },
      branchMap: {},
      b: {},
      fnMap: {},
      f: {},
    },
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value));
}

test('prepareWorkspaceCoverage merges split package coverage into canonical report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-prepare-coverage-'));
  try {
    const packageRoot = path.join(dir, 'packages', 'db');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), '{"name":"@brainstrike/db"}');

    const sourceA = path.join(packageRoot, 'src', 'a.ts');
    const sourceB = path.join(packageRoot, 'src', 'b.ts');
    await Promise.all([
      mkdir(path.join(packageRoot, 'coverage-db-a'), { recursive: true }),
      mkdir(path.join(packageRoot, 'coverage-db-b'), { recursive: true }),
    ]);
    await writeJson(
      path.join(packageRoot, 'coverage-db-a', 'coverage-final.json'),
      fileCoverage(sourceA, 1)
    );
    await writeJson(
      path.join(packageRoot, 'coverage-db-b', 'coverage-final.json'),
      fileCoverage(sourceB, 1)
    );

    const results = prepareWorkspaceCoverage({ roots: [path.join(dir, 'packages')] });

    assert.deepEqual(
      results.map((result) => ({
        files: result.files,
        merged: result.merged,
        packageRoot: path.relative(dir, result.packageRoot),
      })),
      [{ files: 2, merged: true, packageRoot: path.join('packages', 'db') }]
    );
    const merged = JSON.parse(
      await readFile(path.join(packageRoot, 'coverage', 'coverage-final.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(merged).sort(), [sourceA, sourceB].sort());
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
