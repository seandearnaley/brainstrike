import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const helperPath = new URL('../../apps/desktop/e2e/utils/layout-helpers.ts', import.meta.url);
const persistenceSpecPath = new URL(
  '../../apps/desktop/e2e/database-persistence.test.ts',
  import.meta.url
);

test('desktop database cleanup fails closed when cleanup cannot be verified', async () => {
  const source = await readFile(helperPath, 'utf8');
  assert.match(
    source,
    /function failClosedOnUnverifiedCleanup\(reason: string\): never \{\s*throw new Error\(`Database cleanup could not be verified: \$\{reason\}; records were not cleared\.`\);\s*\}/,
    'unverified cleanup must throw its caller-provided failure reason'
  );

  for (const invocationPattern of [
    /failClosedOnUnverifiedCleanup\(`bulk delete threw: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(`bulk delete failed: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(`record-count verification threw: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(\s*'bulk delete reported success but the remaining record count could not be verified'\s*\);/,
    /failClosedOnUnverifiedCleanup\(\s*`bulk delete reported success but left \$\{[^}]+\} records`\s*\);/,
  ]) {
    assert.match(
      source,
      invocationPattern,
      `the cleanup caller must invoke the fail-closed helper: ${invocationPattern}`
    );
  }

  assert.doesNotMatch(
    source,
    /Using UI-based deletion fallback|falling back to UI deletion/,
    'logs must not claim the removed UI deletion path will run'
  );
});

test('database persistence specs do not treat fail-closed cleanup as a graceful skip', async () => {
  const source = await readFile(persistenceSpecPath, 'utf8');

  assert.doesNotMatch(
    source,
    /await clearDatabaseRecords\(([^)]+)\);\s*if \(await isDatabaseError\(\1\)\)/,
    'a failed cleanup must surface instead of reaching a post-cleanup database-error skip'
  );
});
