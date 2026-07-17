import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
        .filter(([, command]) =>
          /\b(?:pnpm\s+)?turbo\s+(?:run\s+)?(?:build|test|type-check|dev|clean)\b/u.test(command)
        )
        .map(([name]) => `${packageJsonPath}:${name}`);
    });

    assert.deepEqual(directTurboScripts, []);
  });

  it('plans oldest cache entries for pruning until the cache is under the byte cap', () => {
    assert.equal(typeof turboCommand.planTurboCachePrune, 'function');

    const deletions = turboCommand.planTurboCachePrune(
      [
        { mtimeMs: 100, path: '/cache/a.tar.zst', size: 60 },
        { mtimeMs: 50, path: '/cache/b.tar.zst', size: 40 },
        { mtimeMs: 75, path: '/cache/c.tar.zst', size: 30 },
      ],
      80
    );

    assert.deepEqual(deletions, ['/cache/b.tar.zst', '/cache/c.tar.zst']);
  });

  it('resolves relative cache directories from the repository root', () => {
    assert.equal(typeof turboCommand.getCacheDirFromArgs, 'function');

    assert.equal(
      turboCommand.getCacheDirFromArgs(['run', 'build', '--cache-dir=.turbo'], '/repo'),
      resolve('/repo/.turbo')
    );
    assert.equal(
      turboCommand.getCacheDirFromArgs(['run', 'build', '--cache-dir', '.turbo'], '/repo'),
      resolve('/repo/.turbo')
    );
  });

  it('skips cache entries that disappear during pruning walks', () => {
    assert.equal(typeof turboCommand.collectCacheFiles, 'function');
    const gone = Object.assign(new Error('entry disappeared'), { code: 'ENOENT' });
    const fakeFileSystem = {
      existsSync: () => true,
      lstatSync: () => {
        throw gone;
      },
      readdirSync: () => [{ name: 'gone.tar.zst' }],
    };

    assert.deepEqual(turboCommand.collectCacheFiles('/cache', { fs: fakeFileSystem }), []);
  });

  it('treats cache pruning errors as non-fatal housekeeping warnings', () => {
    assert.equal(typeof turboCommand.pruneTurboCache, 'function');
    const warnings = [];

    assert.doesNotThrow(() => {
      turboCommand.pruneTurboCache(
        '/cache',
        { BRAINSTRIKE_TURBO_CACHE_MAX_BYTES: 'not-a-number' },
        { warn: (message) => warnings.push(message) }
      );
    });

    assert.deepEqual(warnings, [
      'Skipped Turborepo cache pruning: BRAINSTRIKE_TURBO_CACHE_MAX_BYTES must be a positive integer byte count.',
    ]);
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
