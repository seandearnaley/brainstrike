import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {
  findPrivateTestReaders,
  PILOTS,
  verifyPrivateTestInputLocality,
} from '../verify-private-test-input-locality.mjs';

const require = createRequire(import.meta.url);
const turbo = require.resolve('turbo/bin/turbo');
const FULL_TREE_PRIVATE_INPUT_INVOCATION =
  /\bpnpm run lint:private-test-input-locality(?=\s*(?:&&|$))/u;

function write(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

test('required Static lint retains the full-tree private-input verdict', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  assert.match(
    scripts['lint:ci'],
    FULL_TREE_PRIVATE_INPUT_INVOCATION,
    'lint:ci must retain the full-repository private test input verdict'
  );
  for (const narrowedInvocation of [
    'pnpm run lint:private-test-input-locality:bounded',
    'pnpm run lint:private-test-input-locality.bounded',
    'pnpm run lint:private-test-input-locality --repo-root fixture',
  ]) {
    assert.doesNotMatch(
      narrowedInvocation,
      FULL_TREE_PRIVATE_INPUT_INVOCATION,
      'the owner-chain assertion must reject a renamed or argument-narrowed script'
    );
  }
  assert.equal(
    scripts['lint:private-test-input-locality'],
    'node scripts/verify-private-test-input-locality.mjs'
  );
});

test('types build and topo exclude exactly the private files omitted by TypeScript', () => {
  const parsedTsconfig = ts.parseConfigFileTextToJson(
    'packages/types/tsconfig.json',
    readFileSync('packages/types/tsconfig.json', 'utf8')
  );
  assert.equal(parsedTsconfig.error, undefined);
  const tsconfig = parsedTsconfig.config;
  const parsedTurbo = ts.parseConfigFileTextToJson(
    'packages/types/turbo.json',
    readFileSync('packages/types/turbo.json', 'utf8')
  );
  assert.equal(parsedTurbo.error, undefined);
  const exclusions = PILOTS[0].privateTestPatterns.map((pattern) => `!${pattern}`);
  assert.deepEqual(tsconfig.exclude.slice(-exclusions.length), PILOTS[0].privateTestPatterns);
  assert.deepEqual(parsedTurbo.config.tasks.build.inputs.slice(-exclusions.length), exclusions);
  assert.deepEqual(parsedTurbo.config.tasks.topo.inputs.slice(-exclusions.length), exclusions);
});

test('guard rejects imports, dynamic imports and filesystem reads of excluded type specs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-private-reader-'));
  try {
    const cases = {
      'packages/consumer/src/aliased-chain.ts':
        "import fs from 'node:fs'; const read = fs.readFileSync; const next = read; next('../../types/src/private.test.ts');\n",
      'packages/consumer/src/await-import.ts':
        "const { readFile: inspect } = await import('node:fs/promises'); inspect('../../types/src/private.test.ts');\n",
      'packages/consumer/src/bounded-partial.ts':
        "readFile(makePath(a ? 'packages' : 'other', b ? 'types' : 'other', c ? '__tests__' : 'shared', d ? 'x.test.ts' : 'x.ts', e ? 'a' : 'b', f ? 'c' : 'd', g ? 'e' : 'f'));\n",
      'packages/consumer/src/bracket-alias.ts':
        "import fs from 'node:fs'; const read = fs['readFileSync']; read('../../types/src/private.test.ts');\n",
      'packages/consumer/src/capped-alternatives.ts': [
        "let root = 'packages/types';",
        ...Array.from({ length: 70 }, (_, index) => `root = 'packages/other-${index}';`),
        "readFile(makePath(root, '__tests__', name));\n",
      ].join(' '),
      'packages/consumer/src/capped-direct.ts': [
        "let target = 'packages/other/base.ts';",
        ...Array.from({ length: 70 }, (_, index) => `target = 'packages/other/file-${index}.ts';`),
        "target = 'packages/types/src/private.test.ts';",
        'readFile(target);\n',
      ].join(' '),
      'packages/consumer/src/conditional.ts':
        "readFile(flag ? '../../types/__tests__/a.test.ts' : other);\n",
      'packages/consumer/src/copy-async.ts':
        "import { copyFile } from 'node:fs/promises'; copyFile('../../types/src/private.test.ts', './copy.ts');\n",
      'packages/consumer/src/copy.ts':
        "import { copyFileSync } from 'node:fs'; copyFileSync('../../types/src/private.test.ts', './copy.ts');\n",
      'packages/consumer/src/cp-alias.ts':
        "import { cp as clone } from 'node:fs/promises'; clone('../../types/__tests__', './copy', { recursive: true });\n",
      'packages/consumer/src/cp-sync.ts':
        "import fs from 'node:fs'; fs.cpSync('../../types/__tests__', './copy', { recursive: true });\n",
      'packages/consumer/src/destructured.ts':
        "import * as fs from 'node:fs'; const { readFileSync: read } = fs; read('../../types/src/private.test.ts');\n",
      'packages/consumer/src/directory.ts':
        "import { readdirSync } from 'node:fs'; readdirSync('../../types/__tests__');\n",
      'packages/consumer/src/distributed.ts':
        "let directory = '../../types'; directory = '../other'; readFileSync(path.join(directory, '__tests__', 'contract.test.ts'));\n",
      'packages/consumer/src/dynamic-package.ts':
        "const packageDir = getPackage(); readFileSync(path.join(repoRoot, packageDir, '__tests__', 'x.test.ts'));\n",
      'packages/consumer/src/dynamic-partial.ts':
        "void import(root + '/packages/types/__tests__/contract.test.js');\n",
      'packages/consumer/src/dynamic-template.ts': [
        'void import(`../../types/__tests__/',
        String.fromCodePoint(36),
        '{name}',
        '.test.ts`);\n',
      ].join(''),
      'packages/consumer/src/dynamic-workspace-package.ts':
        "const packageDir = getPackage(); readFileSync(path.join('packages', packageDir, '__tests__', 'x.test.ts'));\n",
      'packages/consumer/src/dynamic.ts':
        "void import('../../types/__tests__/contract.test.js');\n",
      'packages/consumer/src/extensionless.ts':
        "void import('../../types/__tests__/contract.test');\n",
      'packages/consumer/src/fs-alias.ts':
        "import { readFileSync as read } from 'node:fs'; read('../../types/__tests__/contract.test.ts');\n",
      'packages/consumer/src/glob.ts':
        "import { globSync as scan } from 'node:fs'; scan('../../types/__tests__/**/*.ts');\n",
      'packages/consumer/src/helper-array.ts':
        "const root = 'packages/types'; readFile(makePath([root, '__tests__', name]));\n",
      'packages/consumer/src/helper-path-alternatives.ts':
        "let root = 'packages/types'; root = 'packages/other'; readFile(makePath(root, '__tests__', name));\n",
      'packages/consumer/src/helper-path.ts':
        "const root = 'packages/types'; readFile(makePath(root, '__tests__', name));\n",
      'packages/consumer/src/indirect-url.ts':
        "const fixture = new URL('../../types/__tests__/contract.test.ts', import.meta.url); readFile(fixture);\n",
      'packages/consumer/src/nested-destructure.ts':
        "import fs from 'node:fs'; const { promises: { readFile: inspect } } = fs; inspect('../../types/src/private.test.ts');\n",
      'packages/consumer/src/package.ts':
        "export * from '@brainstrike/types/__tests__/contract.test.js';\n",
      'packages/consumer/src/path-unknown.ts':
        "readFileSync(path.join(repoRoot, 'packages', 'types', '__tests__', file));\n",
      'packages/consumer/src/path.ts':
        "readFileSync(path.join(repoRoot, 'packages/types', '__tests__/contract.test.ts'));\n",
      'packages/consumer/src/promises.ts':
        "import fsp from 'node:fs/promises'; const open = fsp.opendir; open('../../types/__tests__');\n",
      'packages/consumer/src/reassigned.ts':
        "let target = 'safe'; target = '../../types/src/private.test.ts'; readFile(target);\n",
      'packages/consumer/src/require-destructure.cjs':
        "const { existsSync: exists } = require('fs'); exists('../../types/__tests__');\n",
      'packages/consumer/src/require.cjs': "require('../../types/__tests__/contract.test.js');\n",
      'packages/consumer/src/shadowed-source.ts':
        "const target = '../../types/src/private.test.ts'; function f() { const target = 'safe'; return target; } readFile(target);\n",
      'packages/consumer/src/shadowed.ts':
        "const target = '../../types/__tests__/contract.test.ts'; function f() { const target = 'safe'; return target; } readFile(target);\n",
      'packages/consumer/src/static.ts':
        "export { value } from '../../types/__tests__/contract.test.js';\n",
      'packages/consumer/src/url.ts':
        "readFileSync(new URL('../../types/__tests__/contract.test.ts', import.meta.url));\n",
      'packages/types/__tests__/contract.test.ts': 'export const value = 1;\n',
      'packages/types/src/leak.ts': "export * from '../__tests__/contract.test.js';\n",
    };
    for (const [file, content] of Object.entries(cases)) {
      write(root, file, content);
      const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      assert.deepEqual(parsed.parseDiagnostics, [], `${file} must be valid fixture source`);
    }
    const findings = findPrivateTestReaders({ files: Object.keys(cases), root });
    assert.deepEqual(
      findings.map(({ file }) => file).sort(),
      Object.keys(cases)
        .filter((file) => file !== 'packages/types/__tests__/contract.test.ts')
        .sort()
    );
    assert.throws(
      () => verifyPrivateTestInputLocality({ files: Object.keys(cases), root }),
      /Move shared contracts\/fixtures outside excluded test paths/u
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('guard conservatively keeps the types __tests__ namespace private', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-private-helper-'));
  try {
    const files = [
      'packages/consumer/src/use-helper.ts',
      'packages/consumer/src/other-package.ts',
      'packages/types/__tests__/helper.ts',
    ];
    write(root, files[0], "export * from '../../types/__tests__/helper.js';\n");
    write(
      root,
      files[1],
      "readFileSync(path.join(repoRoot, 'packages/other', '__tests__', 'x.test.ts'));\n"
    );
    write(root, files[2], 'export const helper = true;\n');
    assert.deepEqual(
      findPrivateTestReaders({ files, root }).map(({ file }) => file),
      [files[0]]
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('types private specs stay local while source, shared fixtures and generic setup propagate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstrike-private-locality-'));
  const parseConfig = (file) => {
    const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
    assert.equal(parsed.error, undefined);
    return parsed.config;
  };
  try {
    const rootConfig = parseConfig('turbo.jsonc');
    const typeConfig = parseConfig('packages/types/turbo.json');
    write(root, 'package.json', JSON.stringify({ packageManager: 'pnpm@11.15.0', private: true }));
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write(root, '.gitignore', '.turbo\n');
    write(
      root,
      'turbo.json',
      JSON.stringify({
        futureFlags: rootConfig.futureFlags,
        tasks: {
          build: { dependsOn: ['^build'], outputs: [] },
          test: { dependsOn: ['topo'], outputs: [] },
          topo: rootConfig.tasks.topo,
        },
      })
    );
    const packages = {
      consumer: { dependencies: { '@brainstrike/utils': 'workspace:*' } },
      'file-tree-test-fixtures': { dependencies: { '@brainstrike/types': 'workspace:*' } },
      'fixture-consumer': {
        dependencies: { '@brainstrike/file-tree-test-fixtures': 'workspace:*' },
      },
      types: {},
      utils: { dependencies: { '@brainstrike/types': 'workspace:*' } },
    };
    for (const [name, extra] of Object.entries(packages)) {
      write(
        root,
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@brainstrike/${name}`,
          scripts: { build: 'node --version', test: 'node --version' },
          version: '1.0.0',
          ...extra,
        })
      );
    }
    write(root, 'packages/types/turbo.json', JSON.stringify(typeConfig));
    write(
      root,
      'packages/consumer/turbo.json',
      JSON.stringify({
        extends: ['//'],
        tasks: { test: { dependsOn: ['$TURBO_EXTENDS$', '@brainstrike/utils#build'] } },
      })
    );
    write(root, 'packages/types/src/index.ts', 'export const value = 1;\n');
    write(root, 'packages/types/__tests__/contract.test.ts', 'test("value", () => {});\n');
    write(root, 'packages/types/vitest.config.mts', 'export default {};\n');
    write(root, 'packages/file-tree-test-fixtures/src/index.ts', 'export const fixture = 1;\n');
    write(root, 'packages/utils/src/index.ts', 'export const utility = 1;\n');
    write(root, 'packages/consumer/src/index.ts', 'export const consumer = 1;\n');
    write(root, 'packages/fixture-consumer/src/index.ts', 'export const consumer = 1;\n');
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'baseline');
    const plan = (...args) =>
      JSON.parse(
        execFileSync(process.execPath, [turbo, 'run', 'test', '--dry=json', ...args], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            TURBO_SCM_BASE: 'HEAD~1',
            TURBO_SCM_HEAD: 'HEAD',
            TURBO_TELEMETRY_DISABLED: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    const hash = (result, taskId) => {
      const entry = result.tasks.find((task) => task.taskId === taskId);
      assert.ok(entry, `${taskId} must be present in the pinned Turbo plan`);
      assert.ok(entry.hash, `${taskId} must have a cache hash`);
      return entry.hash;
    };
    const selected = (result) =>
      result.tasks
        .filter((task) => task.command !== '<NONEXISTENT>')
        .map((task) => task.taskId)
        .sort();
    const commitChange = (file, content, message) => {
      const before = plan();
      write(root, file, content);
      git('add', file);
      git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', message);
      return { affected: plan('--affected'), after: plan(), before };
    };

    const privateSpec = commitChange(
      'packages/types/__tests__/contract.test.ts',
      'test("changed", () => {});\n',
      'private spec'
    );
    assert.notEqual(
      hash(privateSpec.before, '@brainstrike/types#test'),
      hash(privateSpec.after, '@brainstrike/types#test')
    );
    assert.equal(
      hash(privateSpec.before, '@brainstrike/consumer#test'),
      hash(privateSpec.after, '@brainstrike/consumer#test')
    );
    assert.deepEqual(selected(privateSpec.affected), ['@brainstrike/types#test']);

    const source = commitChange(
      'packages/types/src/index.ts',
      'export const value = 2;\n',
      'source'
    );
    assert.notEqual(
      hash(source.before, '@brainstrike/consumer#test'),
      hash(source.after, '@brainstrike/consumer#test')
    );
    assert.ok(selected(source.affected).includes('@brainstrike/consumer#test'));

    const fixture = commitChange(
      'packages/file-tree-test-fixtures/src/index.ts',
      'export const fixture = 2;\n',
      'shared fixture'
    );
    assert.notEqual(
      hash(fixture.before, '@brainstrike/fixture-consumer#test'),
      hash(fixture.after, '@brainstrike/fixture-consumer#test')
    );
    assert.ok(selected(fixture.affected).includes('@brainstrike/fixture-consumer#test'));

    const setup = commitChange(
      'packages/types/vitest.config.mts',
      'export default { test: {} };\n',
      'generic setup'
    );
    assert.notEqual(
      hash(setup.before, '@brainstrike/consumer#test'),
      hash(setup.after, '@brainstrike/consumer#test')
    );
    assert.ok(selected(setup.affected).includes('@brainstrike/consumer#test'));

    // Negative control: without the guarded exclusions, the same private spec
    // both changes the downstream hash and selects the downstream test.
    write(
      root,
      'packages/types/turbo.json',
      JSON.stringify({
        extends: ['//'],
        tasks: { build: {}, test: typeConfig.tasks.test, topo: {} },
      })
    );
    git('add', 'packages/types/turbo.json');
    git(
      '-c',
      'user.name=CI',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'unsafe config'
    );
    const unsafeBefore = plan();
    write(root, 'packages/types/__tests__/contract.test.ts', 'test("unsafe", () => {});\n');
    git('add', 'packages/types/__tests__/contract.test.ts');
    git(
      '-c',
      'user.name=CI',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'private again'
    );
    const unsafeAfter = plan();
    assert.notEqual(
      hash(unsafeBefore, '@brainstrike/consumer#test'),
      hash(unsafeAfter, '@brainstrike/consumer#test')
    );
    assert.ok(selected(plan('--affected')).includes('@brainstrike/consumer#test'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
