import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const helperPath = new URL('../../apps/desktop/e2e/utils/layout-helpers.ts', import.meta.url);

test('desktop database UI cleanup fails closed when the dead fallback cannot remove rows', async () => {
  const source = await readFile(helperPath, 'utf8');
  const start = source.indexOf('async function clearDatabaseRecordsViaUI');
  const end = source.indexOf('async function resolveActivePage', start);

  assert.notEqual(start, -1, 'clearDatabaseRecordsViaUI must exist');
  assert.notEqual(end, -1, 'clearDatabaseRecordsViaUI must have a bounded source region');

  const cleanupSource = source.slice(start, end);
  assert.match(
    cleanupSource,
    /throw new Error\(\s*'Database UI cleanup is unavailable after the bulk delete API failed; records were not cleared\.'\s*\);/,
    'the unavailable fallback must surface the failed cleanup'
  );
  assert.doesNotMatch(
    cleanupSource,
    /return\s+/,
    'the unavailable fallback must not retain a silent-success return path'
  );
});
