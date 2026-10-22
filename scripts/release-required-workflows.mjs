// The nightly workflows a desktop release commit must pass (BST-2190). This is
// the one definition: scripts/resolve-release-sha.mjs judges a commit against
// it, and .github/workflows/release.yml builds only the commit it resolves.
// The required workflows (test, desktop-e2e) run as one scheduled run of
// nightly.yml, on one commit, and that run succeeds only when every call did.
export const REQUIRED_NIGHTLY_WORKFLOWS = Object.freeze(['nightly.yml']);
