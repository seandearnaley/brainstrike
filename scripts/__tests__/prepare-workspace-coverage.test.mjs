import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { prepareWorkspaceCoverage } from '../prepare-workspace-coverage.mjs';

function fileCoverage(filePath, hits) {
  return {
    [filePath]: {
      b: {},
      branchMap: {},
      f: {},
      fnMap: {},
      path: filePath,
      s: { 0: hits },
      statementMap: {
        0: { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
      },
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
    await Promise.all([
      mkdir(path.join(packageRoot, 'node_modules', 'bad-package', 'coverage'), {
        recursive: true,
      }),
      mkdir(path.join(packageRoot, '.turbo', 'coverage'), { recursive: true }),
      mkdir(path.join(dir, '.git', 'coverage'), { recursive: true }),
    ]);
    await writeJson(
      path.join(packageRoot, 'node_modules', 'bad-package', 'coverage', 'coverage-final.json'),
      fileCoverage(path.join(packageRoot, 'node_modules', 'bad-package', 'index.js'), 1)
    );
    await writeJson(
      path.join(packageRoot, '.turbo', 'coverage', 'coverage-final.json'),
      fileCoverage(path.join(packageRoot, '.turbo', 'cache.js'), 1)
    );
    await writeJson(
      path.join(dir, '.git', 'coverage', 'coverage-final.json'),
      fileCoverage(path.join(dir, '.git', 'ignored.js'), 1)
    );

    const results = prepareWorkspaceCoverage({
      roots: [path.relative(process.cwd(), path.join(dir, 'packages'))],
    });

    assert.deepEqual(
      results.map((result) => ({
        cleaned: result.cleaned,
        files: result.files,
        merged: result.merged,
        packageRoot: path.relative(dir, result.packageRoot),
      })),
      [{ cleaned: 2, files: 2, merged: true, packageRoot: path.join('packages', 'db') }]
    );
    const merged = JSON.parse(
      await readFile(path.join(packageRoot, 'coverage', 'coverage-final.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(merged).sort(), [sourceA, sourceB].sort());
    await assert.rejects(access(path.join(packageRoot, 'coverage-db-a')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(packageRoot, 'coverage-db-b')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('credits shared source to its owning package and unions independent consumer coverage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-shared-coverage-'));
  try {
    const roots = ['packages', 'apps'].map((name) => path.join(dir, name));
    const owner = path.join(roots[0], 'shared');
    const consumer = path.join(roots[1], 'desktop');
    for (const packageRoot of [owner, consumer]) {
      await mkdir(path.join(packageRoot, 'coverage'), { recursive: true });
      await writeJson(path.join(packageRoot, 'package.json'), { name: path.basename(packageRoot) });
    }
    const shared = path.join(owner, 'src', 'shared.ts');
    const untested = path.join(owner, 'src', 'untested.ts');
    const app = path.join(consumer, 'src', 'app.ts');
    await writeJson(path.join(owner, 'coverage', 'coverage-final.json'), {
      ...fileCoverage(shared, 0),
      ...fileCoverage(untested, 0),
    });
    await writeJson(path.join(consumer, 'coverage', 'coverage-final.json'), {
      ...fileCoverage(shared, 3),
      ...fileCoverage(app, 1),
    });
    prepareWorkspaceCoverage({ roots });
    const ownerReport = JSON.parse(
      await readFile(path.join(owner, 'coverage', 'coverage-final.json'), 'utf8')
    );
    const consumerReport = JSON.parse(
      await readFile(path.join(consumer, 'coverage', 'coverage-final.json'), 'utf8')
    );
    assert.equal(ownerReport[shared].s[0], 3);
    assert.equal(ownerReport[untested].s[0], 0);
    assert.deepEqual(Object.keys(consumerReport), [app]);
    // Re-preparing must not discard the consumer's contribution.
    prepareWorkspaceCoverage({ roots });
    const repeated = JSON.parse(
      await readFile(path.join(owner, 'coverage', 'coverage-final.json'), 'utf8')
    );
    assert.equal(repeated[shared].s[0], 3);
    assert.equal(repeated[untested].s[0], 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
