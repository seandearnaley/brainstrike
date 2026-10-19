// The nightly workflows a desktop release commit must pass (BST-2190). This is
// the one definition: scripts/resolve-release-sha.mjs judges a commit against
// it, and .github/workflows/release.yml builds only the commit it resolves.
// BST-2233: the six required workflows (test, nightly-coverage, performance,
// desktop-e2e, web-e2e, native-package-matrix) run as one scheduled run of
// nightly.yml, on one commit, and that run succeeds only when every call did.
// scripts/__tests__/release-sha-resolution.test.mjs holds it to that caller
// and requires it to exist with a schedule trigger.
export const REQUIRED_NIGHTLY_WORKFLOWS = Object.freeze(['nightly.yml']);
