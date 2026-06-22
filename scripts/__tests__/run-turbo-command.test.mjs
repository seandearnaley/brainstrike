import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as turboCommand from '../run-turbo-command.mjs';

describe('run turbo command helper', () => {
  it('uses an explicit cache directory outside the repo when no cache is configured', () => {
    assert.equal(typeof turboCommand.buildTurboArgs, 'function');

    const args = turboCommand.buildTurboArgs(['run', 'build'], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    });

    assert.deepEqual(args, [
      'run',
      'build',
      '--cache-dir=/Users/tester/Library/Caches/BrainStrike/turbo',
    ]);
  });

  it('does not override an explicit turbo cache directory', () => {
    assert.equal(typeof turboCommand.buildTurboArgs, 'function');

    const args = turboCommand.buildTurboArgs(['run', 'build', '--cache-dir=.turbo'], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    });

    assert.deepEqual(args, ['run', 'build', '--cache-dir=.turbo']);
  });

  it('routes workspace turbo scripts through the bounded wrapper', () => {
    const directTurboScripts = findPackageJsonFiles(process.cwd()).flatMap((packageJsonPath) => {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return Object.entries(packageJson.scripts ?? {})
        .filter(([, command]) => /\b(?:pnpm\s+)?turbo\s+(?:run\s+)?(?:build|test|type-check|dev|clean)\b/u.test(command))
        .map(([name]) => `${packageJsonPath}:${name}`);
    });

    assert.deepEqual(directTurboScripts, []);
  });

  it('plans oldest cache entries for pruning until the cache is under the byte cap', () => {
    assert.equal(typeof turboCommand.planTurboCachePrune, 'function');

    const deletions = turboCommand.planTurboCachePrune(
      [
        { path: '/cache/a.tar.zst', size: 60, mtimeMs: 100 },
        { path: '/cache/b.tar.zst', size: 40, mtimeMs: 50 },
        { path: '/cache/c.tar.zst', size: 30, mtimeMs: 75 },
      ],
      80
    );

    assert.deepEqual(deletions, ['/cache/b.tar.zst', '/cache/c.tar.zst']);
  });
});

function findPackageJsonFiles(root) {
  const packageJsonFiles = [];
  const ignored = new Set(['.git', '.turbo', 'dist', 'node_modules']);

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'package.json') {
        packageJsonFiles.push(join(dir, entry.name));
        continue;
      }

      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      if (statSync(child).isDirectory()) {
        visit(child);
      }
    }
  }

  visit(root);
  return packageJsonFiles;
}
