import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const helperPath = new URL('../../apps/desktop/e2e/utils/layout-helpers.ts', import.meta.url);

test('desktop database UI cleanup fails closed when the dead fallback cannot remove rows', async () => {
  const source = await readFile(helperPath, 'utf8');
  assert.match(
    source,
    /function failClosedOnUnavailableUiCleanup\(reason: string\): never \{\s*throw new Error\(`Database UI cleanup is unavailable: \$\{reason\}; records were not cleared\.`\);\s*\}/,
    'the unavailable fallback must throw its caller-provided failure reason'
  );

  for (const invocationPattern of [
    /failClosedOnUnavailableUiCleanup\('database is in an error state'\);/,
    /failClosedOnUnavailableUiCleanup\(`bulk delete threw: \$\{detail\}`\);/,
    /failClosedOnUnavailableUiCleanup\(`bulk delete failed: \$\{bulkDeleteResult\.message\}`\);/,
    /failClosedOnUnavailableUiCleanup\(`record-count verification threw: \$\{detail\}`\);/,
    /failClosedOnUnavailableUiCleanup\(\s*'bulk delete reported success but the remaining record count could not be verified'\s*\);/,
    /failClosedOnUnavailableUiCleanup\(\s*`bulk delete reported success but left \$\{remainingCount\} records`\s*\);/,
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
