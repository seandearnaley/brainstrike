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
const readConfig = (file) => {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined);
  return parsed.config;
};

test('provider contract edits invalidate and select their consumer without touching unrelated tests', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-ci-locality-'));
  const document = 'docs/agents/assistant-providers.md';
  const consumer = '@brainstrike/mcp-test-lab';
  const unrelated = '@brainstrike/unrelated';
  const { global, futureFlags, tasks: rootTasks } = readConfig('turbo.jsonc');
  const tasks = {
    test: { dependsOn: rootTasks.test.dependsOn },
    'test:coverage': { dependsOn: rootTasks.test.dependsOn },
    topo: rootTasks.topo,
  };
  try {
    const write = (file, content) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    };
    write('package.json', JSON.stringify({ packageManager: 'pnpm@11.15.0', private: true }));
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
importers:
  .: {}
  packages/mcp-test-lab: {}
  packages/unrelated: {}
  packages/shared: {}
  packages/desktop:
    dependencies:
      '@brainstrike/shared':
        specifier: 'workspace:*'
        version: 'link:../shared'
`
    );
    write('.gitignore', '.turbo\n');
    write(
      'turbo.json',
      JSON.stringify({
        futureFlags,
        global,
        tasks,
      })
    );
    for (const name of ['mcp-test-lab', 'unrelated', 'shared', 'desktop']) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@brainstrike/${name}`,
          ...(name === 'desktop' ? { dependencies: { '@brainstrike/shared': 'workspace:*' } } : {}),
          scripts: { test: 'node --version', 'test:coverage': 'node --version' },
          version: '1.0.0',
        })
      );
    }
    write(
      'packages/mcp-test-lab/turbo.json',
      JSON.stringify(readConfig('packages/mcp-test-lab/turbo.json'))
    );
    write(document, 'original contract\n');
    write('packages/shared/src/index.ts', 'export const answer = 1;\n');
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
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
      'baseline'
    );
    const plan = (...args) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [turbo, 'run', 'test', 'test:coverage', '--dry=json', ...args],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              TURBO_SCM_BASE: 'HEAD~1',
              TURBO_SCM_HEAD: 'HEAD',
              TURBO_TELEMETRY_DISABLED: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
      );
    const before = plan();
    write(document, 'changed contract\n');
    git('add', document);
    git(
      '-c',
      'user.name=CI fixture',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'document update'
    );
    const after = plan();
    const hash = (result, name, task) => {
      const entry = result.tasks.find((item) => item.taskId === `${name}#${task}`);
      assert.ok(entry, `${name}#${task} must be planned`);
      return entry.hash;
    };
    for (const task of ['test', 'test:coverage']) {
      assert.notEqual(hash(before, consumer, task), hash(after, consumer, task));
      assert.equal(hash(before, unrelated, task), hash(after, unrelated, task));
    }
    const affected = plan('--affected');
    assert.deepEqual(
      affected.tasks
        .filter((item) => item.command !== '<NONEXISTENT>')
        .map((item) => item.taskId)
        .sort(),
      [`${consumer}#test`, `${consumer}#test:coverage`]
    );
    assert.deepEqual(
      plan('--affected', '--filter=@brainstrike/unrelated').tasks.filter(
        (item) => item.command !== '<NONEXISTENT>'
      ),
      []
    );
    // Real source dependency changes must still select downstream tests through
    // the same topo edges and positive/negative filter shapes as CI.
    write('packages/shared/src/index.ts', 'export const answer = 2;\n');
    git('add', 'packages/shared/src/index.ts');
    git(
      '-c',
      'user.name=CI fixture',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'source update'
    );
    const executableIds = (result) =>
      result.tasks
        .filter((item) => item.command !== '<NONEXISTENT>')
        .map((item) => item.taskId)
        .sort();
    assert.deepEqual(executableIds(plan('--affected')), [
      '@brainstrike/desktop#test',
      '@brainstrike/desktop#test:coverage',
      '@brainstrike/shared#test',
      '@brainstrike/shared#test:coverage',
    ]);
    assert.deepEqual(executableIds(plan('--affected', '--filter=@brainstrike/desktop')), [
      '@brainstrike/desktop#test',
      '@brainstrike/desktop#test:coverage',
    ]);
    assert.deepEqual(executableIds(plan('--affected', '--filter=!@brainstrike/desktop')), [
      '@brainstrike/shared#test',
      '@brainstrike/shared#test:coverage',
    ]);
    // Negative control: restoring the old global input must destroy locality.
    write(
      'turbo.json',
      JSON.stringify({
        futureFlags,
        global: { ...global, inputs: [...global.inputs, document] },
        tasks,
      })
    );
    const controlBefore = plan();
    write(document, 'another contract change\n');
    assert.notEqual(hash(controlBefore, unrelated, 'test'), hash(plan(), unrelated, 'test'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
