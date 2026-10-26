/**
 * Post-build contract for the preload bundle (BST-1648). A preload runs
 * in a sandboxed renderer where `require` resolves NOTHING but `electron`;
 * every relative import is inlined by `bundle: true`, so the only
 * `require(...)` calls the emitted file may contain are the allowlisted
 * ones. `build-main.mjs` asserts this after every build (the production
 * gate); `src/__tests__/preload-bundle-contract.test.ts` pins the assertion
 * on a real write:false bundle so it never depends on a stale `dist/`.
 */
export const PRELOAD_BUNDLE_ENTRY_NAMES = ['preload'];
export const ALLOWED_PRELOAD_REQUIRES = ['electron'];

const REQUIRE_CALL_PATTERN = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Specifiers required by `source` that a sandboxed preload cannot resolve, deduped and sorted.
 * @param {string} source
 * @returns {string[]}
 */
export function findPreloadBundleRequireViolations(source) {
  /** @type {Set<string>} */
  const violations = new Set();
  for (const [, , specifier] of source.matchAll(REQUIRE_CALL_PATTERN)) {
    if (specifier !== undefined && !ALLOWED_PRELOAD_REQUIRES.includes(specifier)) {
      violations.add(specifier);
    }
  }
  return [...violations].sort();
}

/**
 * @param {string} fileName
 * @param {string} source
 */
export function assertPreloadBundleRequires(fileName, source) {
  const violations = findPreloadBundleRequireViolations(source);
  if (violations.length === 0) {
    return;
  }
  throw new Error(
    `${fileName} requires modules a sandboxed preload cannot resolve: ${violations.join(', ')} (only ${ALLOWED_PRELOAD_REQUIRES.join(', ')} is allowed).`
  );
}
