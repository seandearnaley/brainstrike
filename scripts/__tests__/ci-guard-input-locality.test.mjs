import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepo = (file) => readFileSync(path.join(repoRoot, file), 'utf8');
const require = createRequire(import.meta.url);
const turbo = require.resolve('turbo/bin/turbo');
const chunkGuard = 'scripts/verify-no-cross-chunk-cycles.mjs';
const coverageGuard = 'scripts/enforce-coverage.mjs';
const readConfig = (file) => {
  const parsed = ts.parseConfigFileTextToJson(file, readRepo(file));
  assert.equal(parsed.error, undefined);
  return parsed.config;
};

function workspaceManifestPaths(root) {
  const workspace = parseYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
  assert.ok(Array.isArray(workspace?.packages), 'pnpm-workspace.yaml must declare package globs');
  const positives = workspace.packages.filter((pattern) => !pattern.startsWith('!'));
  const ignore = workspace.packages
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => `${pattern.slice(1)}/package.json`);
  const manifests = globSync(
    positives.map((pattern) => `${pattern}/package.json`),
    { cwd: root, ignore, nodir: true }
  ).sort();
  return ['package.json', ...manifests];
}

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
        expected,
        'guard hash carriers must match the exact consumer set'
      );
      assert.deepEqual(selected, expected, 'affected selection must match the exact consumer set');
    };
    assertLocal(after, ids(plan('--affected')));
    const missingHash = new Map(after);
    missingHash.set(expected[0], before.get(expected[0]));
    assert.throws(
      () => assertLocal(missingHash, expected),
      /guard hash carriers must match the exact consumer set/u,
      'missing hash carrier must fail with the carrier assertion'
    );
    assert.throws(
      () => assertLocal(after, expected.slice(1)),
      /affected selection must match the exact consumer set/u,
      'missing selection must fail with the selection assertion'
    );
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
  const scripts = JSON.parse(readRepo('package.json')).scripts;
  assert.equal(scripts['coverage:enforce'], 'node scripts/enforce-coverage.mjs');
  assert.match(readRepo('.github/workflows/nightly-coverage.yml'), /run: pnpm coverage:enforce/u);
  assert.match(readRepo('scripts/check.mjs'), /command: 'pnpm -s run coverage:enforce'/u);
});

function commandsForTask(manifest, task) {
  const command = manifest.scripts?.[task] ?? '';
  const commands = [command];
  for (const match of command.matchAll(/\bpnpm\s+(?:-s\s+)?(?:run\s+)?(?!exec\b)([\w:-]+)/gu)) {
    const referenced = manifest.scripts?.[match[1]];
    if (referenced) {
      commands.push(referenced);
    }
  }
  return commands;
}

function assertGuardInputs(manifest, config, rootConfig, { isRoot = false } = {}) {
  for (const [task, command] of Object.entries(manifest.scripts ?? {})) {
    if (isRoot && task === 'coverage:enforce' && command === 'node scripts/enforce-coverage.mjs') {
      // This named root command is deliberately invoked after cached coverage
      // artifact collection. It is not itself a Turbo task.
      continue;
    }
    const effectiveTask = config.tasks?.[task] ?? rootConfig.tasks?.[task];
    if (!effectiveTask || effectiveTask.cache === false) {
      continue;
    }
    const commands = commandsForTask(manifest, task);
    assert.doesNotMatch(
      commands.join('\n'),
      /enforce-coverage\.mjs|coverage:enforce/u,
      `${manifest.name}#${task}: coverage enforcement must remain outside cached package tasks`
    );
    if (commands.some((candidate) => candidate.includes('verify-no-cross-chunk-cycles.mjs'))) {
      assert.ok(
        config.tasks?.[task]?.inputs?.includes(`$TURBO_ROOT$/${chunkGuard}`),
        `${manifest.name}#${task} must hash its chunk guard to prevent stale build success`
      );
    }
  }
}

test('every workspace guard consumer carries its task input and coverage stays uncached', () => {
  const config = readConfig('turbo.jsonc');
  for (const task of ['build', 'build:renderer']) {
    assert.equal(
      config.tasks[task]?.inputs,
      undefined,
      `${task}: root inputs changed; explicitly preserve them in app overrides`
    );
  }
  assert.ok(
    config.tasks['test:coverage'].outputs.includes('coverage/**'),
    'coverage cache hits must restore artifacts before uncached enforcement'
  );
  let consumers = 0;
  for (const manifestPath of workspaceManifestPaths(repoRoot)) {
    const relative = path.dirname(manifestPath);
    const manifest = JSON.parse(readRepo(manifestPath));
    const turboPath = relative === '.' ? 'turbo.jsonc' : `${relative}/turbo.json`;
    const local = existsSync(path.join(repoRoot, turboPath)) ? readConfig(turboPath) : {};
    assertGuardInputs(manifest, local, config, { isRoot: manifestPath === 'package.json' });
    consumers += Object.keys(manifest.scripts ?? {}).filter((task) =>
      commandsForTask(manifest, task).some((command) =>
        command.includes('verify-no-cross-chunk-cycles.mjs')
      )
    ).length;
    const coverage = local.tasks?.['test:coverage'];
    if (manifest.scripts?.['test:coverage'] && coverage?.cache !== false && coverage?.outputs) {
      assert.ok(
        coverage.outputs.includes('coverage/**'),
        `${manifest.name}: coverage outputs must survive cache hits`
      );
    }
  }
  assert.ok(consumers >= 2, 'guard consumer discovery must not pass vacuously');
  assert.throws(
    () =>
      assertGuardInputs(
        {
          name: 'fourth-app',
          scripts: { build: 'node ../../scripts/verify-no-cross-chunk-cycles.mjs dist' },
        },
        {},
        config
      ),
    /fourth-app#build must hash its chunk guard/u
  );
  assert.throws(
    () =>
      assertGuardInputs(
        { name: 'fourth-app', scripts: { build: 'pnpm coverage:enforce' } },
        {},
        config
      ),
    /fourth-app#build: coverage enforcement must remain outside cached package tasks/u
  );
  assert.throws(
    () =>
      assertGuardInputs(
        {
          name: 'indirect-chunks',
          scripts: {
            build: 'pnpm run verify:chunks',
            'verify:chunks': 'node ../../scripts/verify-no-cross-chunk-cycles.mjs dist',
          },
        },
        {},
        config
      ),
    /indirect-chunks#build must hash its chunk guard/u
  );
  assert.throws(
    () =>
      assertGuardInputs(
        {
          name: 'indirect-coverage',
          scripts: {
            enforce: 'node ../../scripts/enforce-coverage.mjs',
            'test:coverage': 'pnpm run enforce',
          },
        },
        { tasks: { 'test:coverage': { cache: true } } },
        config
      ),
    /indirect-coverage#test:coverage: coverage enforcement must remain outside cached package tasks/u
  );
});

test('workspace manifest discovery follows pnpm workspace globs and includes the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-workspace-discovery-'));
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  try {
    write('package.json', JSON.stringify({ name: 'root' }));
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/config/*\n  - tooling/*\n');
    write('apps/web/package.json', JSON.stringify({ name: 'web' }));
    write('packages/config/nested/package.json', JSON.stringify({ name: 'nested' }));
    write('packages/not-in-workspace/package.json', JSON.stringify({ name: 'excluded' }));
    write('tooling/new-workspace/package.json', JSON.stringify({ name: 'new-workspace' }));
    assert.deepEqual(workspaceManifestPaths(root), [
      'package.json',
      'apps/web/package.json',
      'packages/config/nested/package.json',
      'tooling/new-workspace/package.json',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
