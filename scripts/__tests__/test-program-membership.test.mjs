import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditWorkspaceTestPrograms,
  canonicalTestPrograms,
  discoverTypeScriptTests,
  evaluateTestProgramDebt,
  inventoryTestPrograms,
} from '../test-program-membership.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const emptyPolicy = () => ({ debt: [], executionAssets: [], version: 1 });

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'workspace-test-program-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const write = (file, value) => {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('pnpm-workspace.yaml', 'packages:\n  - modules/*\n');
  write('modules/fixture/package.json', {
    name: '@fixture/test',
    scripts: { 'check:types': 'tsc --noEmit', 'type-check': 'pnpm check:types' },
  });
  const config = (include) =>
    write('modules/fixture/tsconfig.json', {
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, types: [] },
      include,
    });
  write('modules/fixture/src/seed.spec.ts', 'export {};\n');
  config(['src/seed.spec.ts']);
  return { config, directory, write };
}

test('actual compiler membership rejects new nested files while an old test remains', (t) => {
  const f = fixture(t);
  assert.deepEqual(evaluateTestProgramDebt(inventoryTestPrograms(f.directory), emptyPolicy()), []);
  for (const file of [
    'nested/new.spec.ts',
    'nested/new.test.tsx',
    'nested/new.spec.mts',
    'nested/new.test.cts',
    '__tests__/fixtures/input.ts',
  ]) {
    f.write(`modules/fixture/src/${file}`, 'export {};\n');
  }
  const omitted = inventoryTestPrograms(f.directory);
  assert.equal(evaluateTestProgramDebt(omitted, emptyPolicy()).length, 5);
  const debt = omitted.missing.map(({ axis, path: file }) => ({
    axis,
    owner: 'BST-1613',
    paths: [file],
    reason: 'Fixture debt',
  }));
  assert.deepEqual(evaluateTestProgramDebt(omitted, { ...emptyPolicy(), debt }), []);
  // Count-preserving replacement cannot inherit a previous path's permission.
  rmSync(path.join(f.directory, 'modules/fixture/src/nested/new.test.cts'));
  f.write('modules/fixture/src/nested/replacement.test.cts', 'export {};\n');
  const changed = evaluateTestProgramDebt(inventoryTestPrograms(f.directory), {
    ...emptyPolicy(),
    debt,
  });
  assert.ok(changed.some((message) => message.startsWith('Unchecked test:')));
  assert.ok(changed.some((message) => message.startsWith('Stale debt entry')));
  f.config(['src/**/*']);
  assert.deepEqual(evaluateTestProgramDebt(inventoryTestPrograms(f.directory), emptyPolicy()), []);
});

test('Effect-only test coverage does not earn canonical compiler coverage', (t) => {
  const f = fixture(t);
  f.write('modules/fixture/src/index.ts', 'export {};\n');
  f.config(['src/index.ts']);
  f.write('modules/fixture/tsconfig.test.json', {
    compilerOptions: { plugins: [{ name: '@effect/language-service' }] },
    extends: './tsconfig.json',
    include: ['src/**/*'],
  });
  f.write('modules/fixture/package.json', {
    name: '@fixture/test',
    scripts: {
      'type-check': 'tsc --noEmit && effect-tsgo diagnostics --project tsconfig.test.json --strict',
    },
  });
  const inventory = inventoryTestPrograms(f.directory);
  assert.deepEqual(inventory.missing, [
    { axis: 'typescript', path: 'modules/fixture/src/seed.spec.ts' },
  ]);
  assert.equal(inventory.projectsInspected, 2);
});

test('an effect-tsgo step covers nothing unless its resolved tsconfig enables the language service', (t) => {
  const f = fixture(t);
  f.write('modules/fixture/package.json', {
    name: '@fixture/test',
    scripts: {
      'type-check': 'tsc --noEmit && effect-tsgo diagnostics --project tsconfig.json --strict',
    },
  });
  // Without the plugin effect-tsgo skips every file of the project and still exits 0.
  const unplugged = inventoryTestPrograms(f.directory);
  assert.deepEqual(unplugged.missing, [
    { axis: 'effect', path: 'modules/fixture/src/seed.spec.ts' },
  ]);
  assert.deepEqual(evaluateTestProgramDebt(unplugged, emptyPolicy()), [
    'Unchecked test: effect:modules/fixture/src/seed.spec.ts',
  ]);
  // A plugin inherited through `extends` counts, as it does for effect-tsgo itself.
  f.write('modules/fixture/tsconfig.base.json', {
    compilerOptions: { plugins: [{ name: '@effect/language-service' }] },
  });
  f.write('modules/fixture/tsconfig.json', {
    compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, types: [] },
    extends: './tsconfig.base.json',
    include: ['src/seed.spec.ts'],
  });
  assert.deepEqual(inventoryTestPrograms(f.directory).missing, []);
  // `diagnostics: false` reports every file checked yet emits no Effect diagnostics.
  f.write('modules/fixture/tsconfig.base.json', {
    compilerOptions: { plugins: [{ diagnostics: false, name: '@effect/language-service' }] },
  });
  assert.deepEqual(inventoryTestPrograms(f.directory).missing, [
    { axis: 'effect', path: 'modules/fixture/src/seed.spec.ts' },
  ]);
});

test('new workspace layouts cannot escape discovery and missing commands are uncovered', (t) => {
  const f = fixture(t);
  f.write('pnpm-workspace.yaml', 'packages:\n  - modules/*\n  - nested/config/*\n');
  f.write('nested/config/new/package.json', { name: '@fixture/new' });
  f.write('nested/config/new/test/input.test.ts', 'export {};\n');
  const result = evaluateTestProgramDebt(inventoryTestPrograms(f.directory), emptyPolicy());
  assert.deepEqual(result, ['Unchecked test: typescript:nested/config/new/test/input.test.ts']);
});

test('a compiler inspection failure and an unsupported script never become debt', (t) => {
  const f = fixture(t);
  assert.throws(() => inventoryTestPrograms(f.directory, () => []), /empty program/u);
  f.write('modules/fixture/tsconfig.json', { extends: './missing.json' });
  assert.throws(() => inventoryTestPrograms(f.directory), /Unable to inspect/u);
  assert.throws(
    () =>
      canonicalTestPrograms({
        dir: f.directory,
        name: 'fixture',
        scripts: { 'type-check': 'other-checker' },
      }),
    /Unsupported type-check/u
  );
  assert.throws(
    () =>
      canonicalTestPrograms({
        dir: f.directory,
        name: 'fixture',
        scripts: { 'type-check': 'tsc --noEmit --noCheck' },
      }),
    /Unsupported compiler inspection/u
  );
  assert.throws(
    () =>
      canonicalTestPrograms({
        dir: f.directory,
        name: 'fixture',
        scripts: { recurse: 'pnpm recurse', 'type-check': 'pnpm recurse' },
      }),
    /Cycle detected/u
  );
});

test('execution assets require an exact live path and owner and cannot conceal another test', (t) => {
  const f = fixture(t);
  f.write('modules/fixture/tasks/verify/hidden.test.ts', 'export {};\n');
  const policy = {
    ...emptyPolicy(),
    executionAssets: [
      {
        owner: 'eval candidate verifier',
        path: 'modules/fixture/tasks/verify/hidden.test.ts',
        reason: 'Runs in copied target workspace',
      },
    ],
  };
  assert.deepEqual(evaluateTestProgramDebt(inventoryTestPrograms(f.directory), policy), []);
  f.write('modules/fixture/tasks/verify/another.test.ts', 'export {};\n');
  assert.equal(evaluateTestProgramDebt(inventoryTestPrograms(f.directory), policy).length, 1);
  rmSync(path.join(f.directory, 'modules/fixture/tasks/verify/hidden.test.ts'));
  assert.ok(
    evaluateTestProgramDebt(inventoryTestPrograms(f.directory), policy).some((error) =>
      error.startsWith('Invalid or stale execution asset')
    )
  );
});

test('generated files are excluded while ordinary nested test fixtures remain discoverable', (t) => {
  const f = fixture(t);
  f.write('modules/fixture/dist/ignored.test.ts', 'export {};\n');
  f.write('modules/fixture/node_modules/ignored.test.ts', 'export {};\n');
  for (const generated of ['release/linux-unpacked', 'resources/python-runtime/unpacked']) {
    f.write(`modules/fixture/${generated}/python/bin/python3.13`, '');
    symlinkSync(
      'python3.13',
      path.join(f.directory, `modules/fixture/${generated}/python/bin/python3`)
    );
  }
  assert.deepEqual(discoverTypeScriptTests(path.join(f.directory, 'modules/fixture')), [
    'src/seed.spec.ts',
  ]);
});

test('workspace compiler and Effect test debt is exact and only shrinks', () => {
  const result = auditWorkspaceTestPrograms(root);
  assert.deepEqual(result.errors, []);
  assert.ok(result.reports.length >= 60, 'the real workspace must remain nonempty');
  assert.ok(result.projectsInspected > 60, 'real compiler projects must be inspected');
  const policy = JSON.parse(
    readFileSync(path.join(root, 'scripts/test-program-debt.json'), 'utf8')
  );
  assert.ok(
    policy.debt.every((entry) => entry.paths.every((file) => !file.startsWith('packages/agent/'))),
    'agent has zero debt'
  );
});
