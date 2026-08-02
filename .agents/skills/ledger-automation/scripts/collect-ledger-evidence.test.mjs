import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-ledger-evidence.mjs'
);

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function commitAll(repo, message) {
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', message], repo);
  return run('git', ['rev-parse', 'HEAD'], repo);
}

function migrationSource(symbol, sql) {
  return `export const ${symbol}: Migration = {\n  up: \`${sql}\`,\n};\n`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-collector-'));
  const repo = path.join(root, 'brainstrike');
  fs.mkdirSync(repo);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'ledger@example.test'], repo);
  run('git', ['config', 'user.name', 'Ledger Test'], repo);

  write(
    repo,
    'packages/db/src/migrations/001-init.ts',
    migrationSource('migration001Init', 'CREATE TABLE widgets (id TEXT PRIMARY KEY);')
  );
  write(
    repo,
    'packages/db/src/migrations/index.ts',
    [
      "import { migration001Init } from './001-init.js';",
      '',
      'export const migrations = [',
      '  migration001Init,',
      '];',
      '',
    ].join('\n')
  );
  write(
    repo,
    'packages/db/src/drizzle/migrate.ts',
    [
      "import { migration001Init } from '../migrations/001-init.js';",
      '',
      'const customMigrations = [',
      "  customMigration('0001', migration001Init),",
      '];',
      '',
    ].join('\n')
  );
  write(
    repo,
    'packages/db/src/architecture/db-runtime-baseline.ts',
    'export const baseline = 1;\n'
  );
  write(
    repo,
    'packages/app-state/src/factory-reset.ts',
    "export const resetTables = ['widgets'];\n"
  );
  write(repo, 'packages/db/src/db-provider.tsx', 'export const provider = true;\n');
  write(repo, 'apps/desktop/src/db-main.ts', 'export const dbMain = true;\n');
  write(repo, 'packages/db/__tests__/widgets-repository.test.ts', "it('exists', () => {});\n");
  const watermark = commitAll(repo, 'fixture base');
  return { repo, root, watermark };
}

function registerMigration002(repo, sql) {
  write(
    repo,
    'packages/db/src/migrations/002-add-gadgets.ts',
    migrationSource('migration002AddGadgets', sql)
  );
  write(
    repo,
    'packages/db/src/migrations/index.ts',
    [
      "import { migration001Init } from './001-init.js';",
      "import { migration002AddGadgets } from './002-add-gadgets.js';",
      '',
      'export const migrations = [',
      '  migration001Init,',
      '  migration002AddGadgets,',
      '];',
      '',
    ].join('\n')
  );
}

function registerMigration002InDrizzle(repo) {
  write(
    repo,
    'packages/db/src/drizzle/migrate.ts',
    [
      "import { migration001Init } from '../migrations/001-init.js';",
      "import { migration002AddGadgets } from '../migrations/002-add-gadgets.js';",
      '',
      'const customMigrations = [',
      "  customMigration('0001', migration001Init),",
      "  customMigration('0002', migration002AddGadgets),",
      '];',
      '',
    ].join('\n')
  );
}

function collect(fixture) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--repo', fixture.repo, '--watermark', fixture.watermark, '--revision', 'HEAD'],
    { encoding: 'utf8' }
  );
}

test('scopes registration parity to added migrations; modified migrations route to human review', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  // Modify existing migration 001 (formatting-class change) and add unregistered-in-drizzle 002.
  write(
    fixture.repo,
    'packages/db/src/migrations/001-init.ts',
    `// reformatted\n${migrationSource('migration001Init', 'CREATE TABLE widgets (id TEXT PRIMARY KEY);')}`
  );
  registerMigration002(fixture.repo, 'CREATE TABLE gadgets (id TEXT);');
  commitAll(fixture.repo, 'modify 001, add 002 without drizzle registration');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.deepEqual(evidence.mechanicalGaps.map((gap) => gap.kind).sort(), [
    'missing-drizzle-custom-migration',
    'missing-drizzle-import',
  ]);
  assert.ok(evidence.mechanicalGaps.every((gap) => gap.migration === 2));
  assert.deepEqual(
    evidence.migrationDelta.map((migration) => migration.number),
    [2]
  );
  assert.deepEqual(
    evidence.modifiedExistingMigrations.map((entry) => entry.number),
    [1]
  );
  assert.ok(
    evidence.semanticReviewCandidates.some(
      (candidate) => candidate.kind === 'modified-existing-migration' && candidate.migration === 1
    )
  );
  assert.equal(evidence.noMigrationDelta, false);
  assert.equal(evidence.factoryResetReview[0].table, 'gadgets');
});

test('reports a modified-only delta as requiring review, never a mechanical gap', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  write(
    fixture.repo,
    'packages/db/src/migrations/001-init.ts',
    `// reformatted only\n${migrationSource('migration001Init', 'CREATE TABLE widgets (id TEXT PRIMARY KEY);')}`
  );
  commitAll(fixture.repo, 'reformat migration 001');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.mechanicalGaps, []);
  assert.deepEqual(evidence.migrationDelta, []);
  assert.equal(evidence.modifiedExistingMigrations.length, 1);
  assert.equal(evidence.noMigrationDelta, false);
  assert.equal(evidence.runtimeBaselineReview.requiredManualReview, true);
});

test('collects migration evidence without the deleted DB lane manifest contract', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  registerMigration002(fixture.repo, 'CREATE TABLE gadgets (id TEXT);');
  registerMigration002InDrizzle(fixture.repo);
  commitAll(fixture.repo, 'add fully registered migration without a lane manifest');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schemaVersion, 2);
  assert.deepEqual(evidence.mechanicalGaps, []);
  assert.equal('testLaneAssignments' in evidence, false);
});

test('surfaces deleted migrations as removed evidence instead of crashing', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  run('git', ['rm', 'packages/db/src/migrations/001-init.ts'], fixture.repo);
  commitAll(fixture.repo, 'delete migration 001');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(
    evidence.removedMigrations.map((entry) => entry.number),
    [1]
  );
  assert.ok(
    evidence.semanticReviewCandidates.some(
      (candidate) => candidate.kind === 'migration-removed' && candidate.migration === 1
    )
  );
  assert.deepEqual(evidence.mechanicalGaps, []);
  assert.equal(evidence.noMigrationDelta, false);
});

test('fails closed when a hardcoded contract path is missing at the revision', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  run('git', ['rm', 'apps/desktop/src/db-main.ts'], fixture.repo);
  commitAll(fixture.repo, 'remove factory reset contract file');

  const result = collect(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /required contract path missing at [0-9a-f]{40}: apps\/desktop\/src\/db-main\.ts/
  );
});

test('extracts UNIQUE INDEX DDL and unqualified object names from schema-qualified statements', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  registerMigration002(
    fixture.repo,
    [
      'CREATE TABLE gadgets (id TEXT);',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_gadgets_name ON public.gadgets (name);',
      'ALTER TABLE public.gadgets ADD COLUMN name TEXT;',
    ].join('\n')
  );
  registerMigration002InDrizzle(fixture.repo);
  commitAll(fixture.repo, 'add index-bearing migration');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.mechanicalGaps, []);
  const shapes = evidence.migrationDelta[0].schemaShape;
  assert.deepEqual(
    shapes.map((shape) => [shape.keyword, shape.object]),
    [
      ['CREATE', 'gadgets'],
      ['CREATE', 'idx_gadgets_name'],
      ['ALTER', 'gadgets'],
    ]
  );
  assert.equal(evidence.runtimeBaselineReview.requiredManualReview, true);
});
