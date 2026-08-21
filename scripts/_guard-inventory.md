architecture-domain-boundaries.mjs → wired/paired/armed → cross-domain import boundaries (direction rules only; package-level escapes/undeclared deps are `turbo boundaries`' job — BST-971 division of labor); channel: required-path
architecture-domain-contract.mjs → wired/paired/armed → complete and valid architecture domain map; channel: required-path
assistant-run-id-producer-guard.mjs → wired/paired/armed → single assistant runId producer (bootstrap-only run-event schema); channel: required-path
browser-events-literal-guard.mjs → wired/paired/armed → shared browser CustomEvent names; channel: required-path
catalog-user-choice-guard.mjs → wired/paired/armed → catalog migrations preserving user model enablement; channel: required-path
check-e2e-destructive-tags.mjs → wired/paired/armed → factory-reset E2E isolation tags; channel: required-path
check-e2e-readiness-contracts.mjs → wired/paired/armed → fast E2E shard DB-readiness isolation; channel: required-path
enforce-coverage.mjs → wired/paired/armed → coverage artifacts and per-package thresholds; contract: scripts/__tests__/enforce-coverage-artifact-contract.test.mjs
forbid-no-memo.mjs → wired/paired/armed → React compiler escape directives; channel: required-path
mastra-stream-chunk-contract.mjs → wired/paired/armed → Mastra chunk union coverage and observable unknown chunks; channel: required-path
model-catalog-migration-contract.mjs → wired/paired/armed → dual migration registration and model remaps; channel: required-path
prune-stale-dist.mjs → wired/paired/armed → stale dist artifacts pruned before non-cleaning tsc builds (global-turbo-cache poisoning class); wired into 35 package `build` scripts; contract: scripts/__tests__/prune-stale-dist.test.mjs
secret-scan.mjs → wired/paired/armed → committed credential patterns; channel: required-path
turbo-boundaries.mjs → wired/paired/armed → package-escaping imports + undeclared dependencies (`turbo boundaries`, verdict scoped to files git does not ignore, since the analyzer reads build output and cannot be told not to); Static-lane step `pnpm run boundaries`, ordered before any dist-producing step for scan cost; contract: scripts/__tests__/turbo-boundaries-gate.test.mjs (BST-967); channel: required-path
unit-shard-partition.mjs → wired/paired/armed → exact Unit shard partition
verify-catalog-references.mjs → wired/paired/armed → pnpm catalog consistency
verify-codecov-status-contract.mjs → wired/paired/armed → Codecov status contexts remaining non-gating
verify-config-load-hash-coverage.mjs → wired/paired/armed → Turbo config-load hash coverage
verify-eslint-warning-baselines.mjs → wired/paired/armed → per-rule ESLint warning budgets remaining exact and error findings staying forbidden; contract: scripts/__tests__/eslint-warning-baseline-contract.test.mjs; channel: required-path
verify-guard-inventory.mjs → wired/paired/armed → authoritative Warden guard classification and inventory integrity; channel: required-path
verify-lockfile-catalog-conformance.mjs → wired/paired/armed → lockfile catalog conformance before dependency installation; channel: required-path
verify-mastra-schema-init-order.mjs → wired/paired/armed → lazy initialization of Mastra memory-schema constants; channel: required-path
verify-minimum-release-age-exclusions.mjs → wired/paired/armed → minimumReleaseAgeExclude entries expiring instead of becoming standing exemptions (publish dates recorded in scripts/minimum-release-age-exclusions.json); channel: required-path
verify-no-cross-chunk-cycles.mjs → wired/paired/armed → acyclic emitted renderer chunk graph
verify-no-raw-nul-bytes.mjs → wired/paired/armed → tracked source files remaining free of raw NUL bytes; channel: required-path
verify-no-source-cycles.mjs → wired/paired/armed → acyclic renderer source module graph; channel: required-path
verify-no-vitest-worker-mutation.mjs → wired/paired/armed → Vitest worker-global mutation; contract: scripts/__tests__/vitest-worker-global-mutation.test.mjs
verify-package-build-strategies.mjs → wired/paired/armed → package build commands matching their declared output ownership; channel: required-path
verify-playwright-pin-sync.mjs → wired/paired/armed → Playwright package and container pin parity
verify-tokenizer-asset-bundle.mjs → wired/paired/armed → tokenizer data staying out of JavaScript bundles; contract: scripts/__tests__/tokenizer-asset-bundle-contract.test.mjs
verify-tsconfig-paths-match-registry.mjs → wired/paired/armed → tsconfig paths matching source-alias registry
verify-tsup-build-invariants.mjs → wired/paired/armed → tsup clean and declaration ownership invariants; channel: required-path
verify-workspace-src-aliases.mjs → wired/paired/armed → test lanes resolving workspace imports from source
