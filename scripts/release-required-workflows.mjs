// The nightly workflows a desktop release commit must pass (BST-2190). This is
// the one definition: scripts/resolve-release-sha.mjs judges a commit against
// it, and .github/workflows/release.yml builds only the commit it resolves.
// nightly.yml runs the complete Unit suite on one commit; every other lane
// already gated that commit's merge-queue batch (owner decision 2026-10-24).
export const REQUIRED_NIGHTLY_WORKFLOWS = Object.freeze(['nightly.yml']);
