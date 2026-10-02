import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseUnitShardMatrix } from '../unit-shard-partition.mjs';

const workflow = await readFile(
  new URL('../../.github/workflows/nightly-coverage.yml', import.meta.url),
  'utf8'
);
const prCoverageWorkflow = await readFile(
  new URL('../../.github/workflows/coverage.yml', import.meta.url),
  'utf8'
);
const unitWorkflow = await readFile(
  new URL('../../.github/workflows/test.yml', import.meta.url),
  'utf8'
);
const dbPackageJson = JSON.parse(
  await readFile(new URL('../../packages/db/package.json', import.meta.url), 'utf8')
);

function parseCoverageDbShards(source) {
  const start = source.indexOf('  db-coverage-shard:\n');
  assert.notEqual(start, -1, 'nightly workflow must declare db-coverage-shard');
  const steps = source.indexOf('\n    steps:', start);
  assert.notEqual(steps, -1, 'db-coverage-shard must declare steps after its matrix');
  const block = source.slice(start, steps);
  const rows = [];
  for (const match of block.matchAll(
    /- shard:\s*(?<name>[^\n]+)\n(?<body>[\s\S]*?)(?=\n\s*- shard:|$)/gu
  )) {
    const shard = /vitest_shard:\s*(?<index>\d+)\/(?<count>\d+)/u.exec(match.groups?.body ?? '');
    assert.ok(shard?.groups, `coverage row ${match.groups?.name} has no vitest_shard`);
    rows.push({
      count: Number(shard.groups.count),
      index: Number(shard.groups.index),
      name: match.groups?.name.trim(),
    });
  }
  assert.ok(rows.length >= 2, `expected at least two DB coverage shards; found ${rows.length}`);
  return rows;
}

function toShardIds(rows) {
  return rows.map((row) => `${row.index}/${row.count}`).sort();
}

function assertCheapDbShardReporter(script) {
  assert.match(script, /--coverage\.reporter=text/u);
  assert.match(script, /--reporter=blob/u);
  assert.doesNotMatch(script, /html|clover|coverage\.reportsDirectory/u);
}

function assertNativeDbShardContract(unitSource, coverageSource) {
  const unitRows = parseUnitShardMatrix(unitSource).filter((row) => row.partition === 'db');
  const coverageRows = parseCoverageDbShards(coverageSource);
  assert.deepEqual(
    unitRows.map((row) => row.shard).sort(),
    ['db-1', 'db-2'],
    'required Unit must have exactly the two DB physical rows'
  );
  assert.deepEqual(
    coverageRows.map((row) => row.name).sort(),
    ['db-1', 'db-2'],
    'nightly coverage must have exactly the same two DB physical rows'
  );
  assert.deepEqual(toShardIds(unitRows.map((row) => row.vitestShard)), ['1/2', '2/2']);
  assert.deepEqual(
    toShardIds(coverageRows),
    ['1/2', '2/2'],
    'nightly coverage must run the same complete native Vitest shard set as Unit'
  );
  const shardJob = coverageSource.slice(
    coverageSource.indexOf('  db-coverage-shard:\n'),
    coverageSource.indexOf('\n  db-coverage:\n')
  );
  assert.match(coverageSource, /pnpm turbo run test:coverage:db:shard/u);
  assert.match(coverageSource, /DB_TEST_SHARD: \$\{\{ matrix\.vitest_shard \}\}/u);
  assert.doesNotMatch(shardJob, /--shard=|coverage\.reportsDirectory/u);
  assert.match(coverageSource, /--merge-reports=\.vitest\/blob/u);
  assert.match(shardJob, /include-hidden-files: true/u);
  assert.match(coverageSource, /if \[ "\$blob_count" -ne 2 \]/u);
  assert.doesNotMatch(
    coverageSource,
    /test:coverage:db:(architecture|check-lanes|chunking|migrations|queue|repositories|runtime|search)/u
  );
}

function assertPrCoverageDbShardContract(unitSource, coverageSource) {
  const unitShardIds = toShardIds(
    parseUnitShardMatrix(unitSource)
      .filter((row) => row.partition === 'db')
      .map((row) => row.vitestShard)
  );
  const loop = coverageSource.match(/for db_test_shard in ([^;]+); do/u);
  assert.ok(loop, 'PR coverage must declare its native DB shard loop');
  const prShardIds = loop[1].trim().split(/\s+/u).sort();
  assert.deepEqual(prShardIds, unitShardIds, 'PR coverage must use the Unit DB shard set');
  assert.match(
    coverageSource,
    /DB_TEST_SHARD="\$db_test_shard" pnpm turbo run test:coverage:db:shard/u
  );
  assert.match(coverageSource, /if \[ "\$blob_count" -ne 2 \]/u);
  assert.match(coverageSource, /--merge-reports=\.vitest\/blob/u);
  assert.match(coverageSource, /packages\/db\/coverage\/coverage-final\.json/u);
  assert.match(
    coverageSource,
    /--filter "!@brainstrike\/db" --workspace-concurrency=4/u,
    'the concurrent affected-package runner must exclude DB'
  );
}

test('nightly package coverage uses six bounded static shards', () => {
  assert.match(workflow, /^ {2}package-coverage:\n/m);
  assert.match(workflow, /fail-fast: false/);

  for (const shard of [
    'agent',
    'app-shell',
    'desktop',
    'embeddings-preferences',
    'ui-db-explorer',
    'remaining',
  ]) {
    assert.match(workflow, new RegExp(`shard: ${shard}`));
  }

  assert.doesNotMatch(workflow, /- name: Run package coverage/);
  assert.match(
    workflow,
    /pnpm turbo run test:coverage[\s\S]*\$\{\{ matrix\.filters \}\}[\s\S]*--concurrency=\$\{\{ matrix\.concurrency \}\}/
  );
  assert.match(
    workflow,
    /shard: remaining[\s\S]*--filter=!@brainstrike\/db[\s\S]*--filter=!@brainstrike\/agent[\s\S]*--filter=!@brainstrike\/db-explorer/
  );
});

test('required Unit and nightly coverage use the same complete native DB shard set', () => {
  assertNativeDbShardContract(unitWorkflow, workflow);
});

test('nightly coverage merges DB blobs natively and fans one artifact into the threshold gate', () => {
  assert.match(workflow, /^ {2}db-coverage-shard:\n/m);
  assert.match(workflow, /^ {2}db-coverage:\n/m);
  assert.match(workflow, /^ {2}coverage:\n/m);
  assert.match(workflow, /needs:\n {6}- package-coverage\n {6}- db-coverage/);
  assert.match(workflow, /uses: actions\/download-artifact@v7/);
  assert.match(workflow, /pattern: nightly-coverage-\*/);
  assert.match(workflow, /if \[ "\$archive_count" -ne 7 \]/);
  assert.match(workflow, /run: pnpm coverage:enforce/);
});

test('PR coverage isolates DB and natively merges the same complete shard set', () => {
  assertPrCoverageDbShardContract(unitWorkflow, prCoverageWorkflow);
});

test('DB coverage shards emit only the blob plus a cheap text summary', () => {
  assertCheapDbShardReporter(dbPackageJson.scripts['test:coverage:db:shard']);
});

test('money test: duplicate nightly shard indices fail parity', () => {
  const mutated = workflow.replace('vitest_shard: 2/2', 'vitest_shard: 1/2');
  assert.notEqual(mutated, workflow, 'the shard-index control must mutate real workflow');
  assert.throws(
    () => assertNativeDbShardContract(unitWorkflow, mutated),
    /nightly coverage must run the same complete native Vitest shard set as Unit/
  );
});

test('money test: removing native Vitest merge fails the contract', () => {
  const mutated = workflow.replace('--merge-reports=.vitest/blob', '--no-merge-reports');
  assert.notEqual(mutated, workflow, 'the merge control must mutate real workflow');
  assert.throws(() => assertNativeDbShardContract(unitWorkflow, mutated), /merge-reports/);
});

test('money test: removing the cheap shard reporter fails the contract', () => {
  const mutated = dbPackageJson.scripts['test:coverage:db:shard'].replace(
    '--coverage.reporter=text',
    ''
  );
  assert.notEqual(mutated, dbPackageJson.scripts['test:coverage:db:shard']);
  assert.throws(() => assertCheapDbShardReporter(mutated), /input did not match/u);
});

test('money test: duplicating a PR coverage shard fails cross-workflow parity', () => {
  const mutated = prCoverageWorkflow.replace(
    'for db_test_shard in 1/2 2/2',
    'for db_test_shard in 1/2 1/2'
  );
  assert.notEqual(mutated, prCoverageWorkflow, 'the PR shard control must mutate real workflow');
  assert.throws(
    () => assertPrCoverageDbShardContract(unitWorkflow, mutated),
    /must use the Unit DB shard set/u
  );
});

test('money test: allowing DB into concurrent PR coverage fails isolation', () => {
  const mutated = prCoverageWorkflow.replace('--filter "!@brainstrike/db"', '');
  assert.notEqual(
    mutated,
    prCoverageWorkflow,
    'the DB-isolation control must mutate real workflow'
  );
  assert.throws(
    () => assertPrCoverageDbShardContract(unitWorkflow, mutated),
    /concurrent affected-package runner must exclude DB/u
  );
});

test('money test: hidden Vitest blobs must remain uploadable', () => {
  const mutated = workflow.replace('          include-hidden-files: true\n', '');
  assert.notEqual(mutated, workflow, 'the hidden-upload control must mutate real workflow');
  assert.throws(
    () => assertNativeDbShardContract(unitWorkflow, mutated),
    /include-hidden-files: true/u
  );
});
