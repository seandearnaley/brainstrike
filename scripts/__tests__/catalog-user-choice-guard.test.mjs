import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditCatalogUserChoiceUpdates } from '../catalog-user-choice-guard.mjs';

const migrationPath = 'packages/db/src/migrations/999-control.ts';

async function writeFixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'catalog-user-choice-guard-'));
  const fullPath = path.join(root, migrationPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source);
  return root;
}

test('real tree: no catalog overwrite exists outside the exact historical allowlist', async () => {
  const result = await auditCatalogUserChoiceUpdates();
  assert.deepEqual(result, { staleAllowlist: [], violations: [] });
});

test('flags a deliberately misbehaving catalog upsert', async () => {
  const root = await writeFixture(`
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      is_enabled = EXCLUDED.is_enabled;
  `);

  const result = await auditCatalogUserChoiceUpdates({ allowedOccurrences: {}, root });
  assert.deepEqual(result, {
    staleAllowlist: [],
    violations: [{ filePath: migrationPath, lineNumber: 4 }],
  });
});

test('pins the exact number of historical occurrences', async () => {
  const root = await writeFixture(`
    is_enabled = EXCLUDED.is_enabled;
    is_enabled = EXCLUDED.is_enabled;
  `);

  const result = await auditCatalogUserChoiceUpdates({
    allowedOccurrences: { [migrationPath]: 1 },
    root,
  });
  assert.deepEqual(result, {
    staleAllowlist: [],
    violations: [{ filePath: migrationPath, lineNumber: 3 }],
  });
});

test('fails when historical debt is removed without pruning the allowlist', async () => {
  const root = await writeFixture('export const migration999 = {};\n');

  const result = await auditCatalogUserChoiceUpdates({
    allowedOccurrences: { [migrationPath]: 1 },
    root,
  });
  assert.deepEqual(result, {
    staleAllowlist: [{ actualCount: 0, allowedCount: 1, filePath: migrationPath }],
    violations: [],
  });
});
