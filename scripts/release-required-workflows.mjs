// The nightly workflows a desktop release commit must pass (BST-2190). This is
// the one definition: scripts/resolve-release-sha.mjs judges a commit against
// it, and .github/workflows/release.yml builds only the commit it resolves.
// scripts/__tests__/release-sha-resolution.test.mjs holds it to the owner's
// named set and requires each workflow to exist with a schedule trigger.
export const REQUIRED_NIGHTLY_WORKFLOWS = Object.freeze([
  'test.yml',
  'nightly-coverage.yml',
  'performance.yml',
  'desktop-e2e.yml',
  'web-e2e.yml',
  'native-package-matrix.yml',
]);
