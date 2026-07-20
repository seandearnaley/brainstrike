/**
 * Test-framework detection for the persistence logging gates.
 *
 * Lives in its own module so tests can replace it with `vi.mock` instead of
 * deleting the real `__vitest_worker__` global. While that global is deleted,
 * vitest's own throttled task-update timer can fire and crash the worker with
 * "Vitest failed to access its internal state" — every test passes but the
 * run exits 1 (BST-591). Never mutate `__vitest_worker__` from test code.
 */
export function detectTestEnvironment(
  globalRecord: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): boolean {
  const processCandidate = globalRecord['process'] as
    | { env?: Record<string, string | undefined> }
    | undefined;
  return (
    processCandidate?.env?.['NODE_ENV'] === 'test' ||
    'vitest' in globalRecord ||
    'jest' in globalRecord ||
    '__vitest_worker__' in globalRecord
  );
}
