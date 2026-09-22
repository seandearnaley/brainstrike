import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findModelsUpdatedAtWriteFailures } from '../model-catalog-migration-contract.mjs';

// Split out from model-catalog-migration-contract.test.mjs (BST-1794 follow-up)
// purely to keep that file under the repo's `noExcessiveLinesPerFile` budget.
// Covers the gap where a migration writes `models.updated_at` or
// `models.created_at` through an INSERT's target-column list
// (`INSERT INTO models (id, name, updated_at) VALUES (...)`) rather than
// through an explicit `updated_at = ...` assignment — see
// `findModelsUpdatedAtWriteFailures` in ../model-catalog-migration-contract.mjs
// for the guard this exercises.

function migrationFile(file, exportName, body) {
  return {
    file,
    source: `
import type { Migration } from './migration-runner';

export const ${exportName}: Migration = {
  version: 25,
  ledgerKey: 'custom-025-fixture',
  name: 'fixture',
  up: \`
    ${body}
  \`,
  down: \`\`,
};
`,
  };
}

describe('models.updated_at write guard — INSERT target-column list (BST-1794 follow-up)', () => {
  it('flags an INSERT that lists updated_at as a target column', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-insert-column-list.ts',
        'migration099FakeInsertColumnList',
        `INSERT INTO models (id, name, updated_at) VALUES ('x', 'X', NOW());`
      ),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.file),
      ['packages/db/src/migrations/099-fake-insert-column-list.ts']
    );
  });

  it('flags an INSERT that lists a quoted "updated_at" target column', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-insert-quoted-column.ts',
        'migration099FakeInsertQuotedColumn',
        `INSERT INTO models (id, "updated_at") VALUES ('x', NOW());`
      ),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.file),
      ['packages/db/src/migrations/099-fake-insert-quoted-column.ts']
    );
  });

  it('flags an INSERT that lists created_at as a target column (resetting created_at launders a row the same way)', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-insert-created-at.ts',
        'migration099FakeInsertCreatedAt',
        `INSERT INTO models (id, created_at) VALUES ('x', NOW());`
      ),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.file),
      ['packages/db/src/migrations/099-fake-insert-created-at.ts']
    );
  });

  it('flags an INSERT ... SELECT that lists updated_at as a target column', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-insert-select-column.ts',
        'migration099FakeInsertSelectColumn',
        'INSERT INTO models (id, updated_at) SELECT id, NOW() FROM staging;'
      ),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.file),
      ['packages/db/src/migrations/099-fake-insert-select-column.ts']
    );
  });

  it('does not flag "updated_at" appearing only inside a string literal value', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-string-literal.ts',
        'migration099FakeStringLiteral',
        `INSERT INTO models (id, name) VALUES ('x', 'updated_at');`
      ),
    ]);

    assert.deepEqual(failures, []);
  });

  it('does not flag a similarly-named column like updated_at_hint', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-similar-column.ts',
        'migration099FakeSimilarColumn',
        `INSERT INTO models (id, name, updated_at_hint) VALUES ('x', 'X', 1);`
      ),
    ]);

    assert.deepEqual(failures, []);
  });

  it('does not flag a providers INSERT that lists updated_at (different table)', () => {
    const failures = findModelsUpdatedAtWriteFailures([
      migrationFile(
        'packages/db/src/migrations/099-fake-providers-insert.ts',
        'migration099FakeProvidersInsert',
        `INSERT INTO providers (id, updated_at) VALUES ('x', NOW());`
      ),
    ]);

    assert.deepEqual(failures, []);
  });
});
