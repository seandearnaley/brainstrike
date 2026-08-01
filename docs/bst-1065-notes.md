# BST-1065 working notes (WIP, will be folded into the PR body / removed before merge)

Tracking doc so this worktree/branch is never mistaken for "unchanged" while work is in
progress. Will be replaced by the real PR description.

## Key finding (verified 2026-08-01)

`@huggingface/transformers` is ALREADY pinned to `^4.2.0` in `pnpm-workspace.yaml`'s pnpm
catalog, and all three consumers (`packages/embedding-worker`, `packages/embeddings`,
`packages/agent`) resolve to `4.2.0` in the current lockfile on `main`. The major-version bump
(3.8.1 -> 4.0.1) landed via commit `ec567fc75` ("deps: workspace-wide dependency update sweep
(waves 1-4)"), a routine automated dependency sweep with no breaking-change review, parity
test, or benchmark. Later routine bumps took it to 4.1.0 then 4.2.0 (`dda1b507e`, `175bcfba5`),
then commit `27814cbd3` (BST-748) moved the already-v4.2.0 pin into the shared pnpm catalog.

This ticket's real remaining scope is therefore the verification work that should have
accompanied that bump: breaking-change audit, a vector-parity regression test, and a
benchmark — not a version bump.

Remaining work: breaking-change audit against upstream v4 release notes, vector-parity test
+ fixture, WASM-backend benchmark (cold/warm, n>=10), renderer-only invariant grep, and the
usual typecheck/lint/unit gate.
