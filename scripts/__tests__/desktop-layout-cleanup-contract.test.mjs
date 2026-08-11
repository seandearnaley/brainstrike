import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const helperPath = new URL('../../apps/desktop/e2e/utils/layout-helpers.ts', import.meta.url);

test('desktop database UI cleanup fails closed when the dead fallback cannot remove rows', async () => {
  const source = await readFile(helperPath, 'utf8');
  assert.match(
    source,
    /function clearDatabaseRecordsViaUI\(reason: string\): never \{\s*throw new Error\(`Database UI cleanup is unavailable: \$\{reason\}; records were not cleared\.`\);\s*\}/,
    'the unavailable fallback must throw its caller-provided failure reason'
  );

  for (const reason of [
    'bulk delete reported success but left',
    'bulk delete reported success but the remaining record count could not be verified',
    'bulk delete failed:',
    'bulk delete threw:',
  ]) {
    assert.ok(
      source.includes(reason),
      `the cleanup caller must preserve the distinct reason: ${reason}`
    );
  }

  assert.doesNotMatch(
    source,
    /Using UI-based deletion fallback|falling back to UI deletion/,
    'logs must not claim the removed UI deletion path will run'
  );
});
