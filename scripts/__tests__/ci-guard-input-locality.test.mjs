import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const turbo = require.resolve('turbo/bin/turbo');
const chunkGuard = 'scripts/verify-no-cross-chunk-cycles.mjs';
const coverageGuard = 'scripts/enforce-coverage.mjs';
const readConfig = (file) => {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined);
  return parsed.config;
};

test('guard edits select and hash only tasks that execute the guard', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-guard-locality-'));
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=CI fixture',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture change'
    );
  };
  const plan = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [turbo, 'run', 'build', 'build:renderer', 'test', '--dry=json', ...args],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            TURBO_SCM_BASE: 'HEAD~1',
            TURBO_SCM_HEAD: 'HEAD',
            TURBO_TELEMETRY_DISABLED: '1',
          },
          stdio: 'pipe',
        }
      )
    );
  const executable = (result) => result.tasks.filter((entry) => entry.command !== '<NONEXISTENT>');
  const hashes = (result) => new Map(executable(result).map((entry) => [entry.taskId, entry.hash]));
  const ids = (result) =>
    executable(result)
      .map((entry) => entry.taskId)
      .sort();
  try {
    const config = readConfig('turbo.jsonc');
    write('package.json', JSON.stringify({ packageManager: 'pnpm@11.15.0', private: true }));
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/web: {}\n  apps/desktop: {}\n  apps/unrelated: {}\n"
    );
    write('.gitignore', '.turbo\n');
    write(
      'turbo.json',
      JSON.stringify({
        futureFlags: config.futureFlags,
        global: config.global,
        tasks: {
          build: config.tasks.build,
          'build:renderer': {},
          test: config.tasks.test,
          topo: config.tasks.topo,
        },
      })
    );
    for (const name of ['web', 'desktop', 'unrelated']) {
      write(
        `apps/${name}/package.json`,
        JSON.stringify({
          name: `@brainstrike/${name}`,
          scripts: {
            build: 'node --version',
            test: 'node --version',
            ...(name === 'desktop' ? { 'build:renderer': 'node --version' } : {}),
          },
          version: '1.0.0',
        })
      );
      if (name !== 'unrelated') {
        const actual = readConfig(`apps/${name}/turbo.json`);
        write(
          `apps/${name}/turbo.json`,
          JSON.stringify({
            extends: ['//'],
            tasks: {
              ...(actual.tasks.build ? { build: actual.tasks.build } : {}),
              ...(actual.tasks['build:renderer']
                ? { 'build:renderer': actual.tasks['build:renderer'] }
                : {}),
            },
          })
        );
      }
    }
    write(chunkGuard, '// original chunk guard\n');
    write(coverageGuard, '// original coverage enforcement\n');
    git('init', '-q');
    commit();
    const before = hashes(plan());
    write(chunkGuard, '// changed chunk guard\n');
    commit();
    const after = hashes(plan());
    const expected = [
      '@brainstrike/desktop#build',
      '@brainstrike/desktop#build:renderer',
      '@brainstrike/web#build',
    ];
    const assertLocal = (candidate, selected) => {
      assert.deepEqual(
        [...candidate]
          .filter(([id, hash]) => before.get(id) !== hash)
          .map(([id]) => id)
          .sort(),
        expected
      );
      assert.deepEqual(selected, expected);
    };
    assertLocal(after, ids(plan('--affected')));
    const missingHash = new Map(after);
    missingHash.set(expected[0], before.get(expected[0]));
    assert.throws(() => assertLocal(missingHash, expected), 'missing hash carrier must fail');
    assert.throws(() => assertLocal(after, expected.slice(1)), 'missing selection must fail');
    write(coverageGuard, '// changed coverage enforcement\n');
    commit();
    assert.deepEqual(
      hashes(plan()),
      after,
      'uncached artifact enforcement does not change build/test outputs'
    );
    assert.deepEqual(ids(plan('--affected')), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('coverage enforcement remains an uncached direct command after artifact collection', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts['coverage:enforce'], 'node scripts/enforce-coverage.mjs');
  assert.match(
    readFileSync('.github/workflows/nightly-coverage.yml', 'utf8'),
    /run: pnpm coverage:enforce/u
  );
  assert.match(
    readFileSync('scripts/check.mjs', 'utf8'),
    /command: 'pnpm -s run coverage:enforce'/u
  );
});
