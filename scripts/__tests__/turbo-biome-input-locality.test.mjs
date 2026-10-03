import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');
function config(file) {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined);
  return parsed.config;
}

test('a formatting-policy edit selects lint and the config reader, retaining unrelated test cache hashes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-biome-locality-'));
  const production = config('turbo.jsonc');
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const plan = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [turbo, 'run', 'test', 'test:coverage', 'lint', '--dry=json', ...args],
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
  try {
    write('package.json', JSON.stringify({ packageManager: 'pnpm@11.15.0', private: true }));
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/config: {}\n  packages/unrelated: {}\n"
    );
    write('.gitignore', '.turbo\n');
    write(
      'turbo.json',
      JSON.stringify({
        futureFlags: production.futureFlags,
        global: production.global,
        tasks: {
          lint: production.tasks.lint,
          test: production.tasks.test,
          'test:coverage': production.tasks['test:coverage'],
          topo: production.tasks.topo,
        },
      })
    );
    for (const name of ['config', 'unrelated']) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@brainstrike/${name}`,
          scripts: {
            lint: 'node --version',
            test: 'node --version',
            'test:coverage': 'node --version',
          },
          version: '1.0.0',
        })
      );
      write(`packages/${name}/src/index.js`, 'export const value = 1;\n');
    }
    write('packages/config/turbo.json', JSON.stringify(config('packages/config/turbo.json')));
    write('biome.json', '{"formatter":{"lineWidth":100}}\n');
    git('init', '-q');
    const commit = () => {
      git('add', '.');
      git(
        '-c',
        'user.name=CI audit fixture',
        '-c',
        'user.email=ci@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture'
      );
    };
    commit();
    const before = plan();
    write('biome.json', '{"formatter":{"lineWidth":120}}\n');
    commit();
    const after = plan();
    const hash = (report, id) => report.tasks.find((task) => task.taskId === id)?.hash;
    for (const task of ['test', 'test:coverage']) {
      const id = `@brainstrike/unrelated#${task}`;
      assert.ok(hash(before, id));
      assert.equal(hash(after, id), hash(before, id), `${id} must retain its cache entry`);
      const configId = `@brainstrike/config#${task}`;
      assert.notEqual(
        hash(after, configId),
        hash(before, configId),
        `${configId} must observe its actual root-file read`
      );
    }
    assert.notEqual(
      hash(after, '@brainstrike/unrelated#lint'),
      hash(before, '@brainstrike/unrelated#lint')
    );
    assert.deepEqual(
      plan('--affected')
        .tasks.filter((task) => ['test', 'test:coverage', 'lint'].includes(task.task))
        .map((task) => task.taskId)
        .sort(),
      [
        '@brainstrike/config#lint',
        '@brainstrike/config#test',
        '@brainstrike/config#test:coverage',
        '@brainstrike/unrelated#lint',
      ]
    );
    // Negative control: restoring the historical global entry must reproduce
    // both broad selection and a different unrelated test hash.
    const widened = config(path.join(root, 'turbo.json'));
    widened.global.inputs.push('biome.json');
    write('turbo.json', JSON.stringify(widened));
    assert.notEqual(
      hash(plan(), '@brainstrike/unrelated#test'),
      hash(after, '@brainstrike/unrelated#test')
    );
    assert.ok(
      plan('--affected').tasks.some((task) => task.taskId === '@brainstrike/unrelated#test')
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
