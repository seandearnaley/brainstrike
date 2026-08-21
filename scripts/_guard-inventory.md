architecture-domain-boundaries.mjs → wired=yes/paired=yes/armed=yes → cross-domain import boundaries (direction rules only; package-level escapes/undeclared deps are `turbo boundaries`' job — BST-971 division of labor); channel: required-path
architecture-domain-contract.mjs → wired=yes/paired=yes/armed=yes → complete and valid architecture domain map; channel: required-path
assistant-run-id-producer-guard.mjs → wired=yes/paired=yes/armed=yes → single assistant runId producer (bootstrap-only run-event schema); channel: required-path
browser-events-literal-guard.mjs → wired=yes/paired=yes/armed=yes → shared browser CustomEvent names; channel: required-path
catalog-user-choice-guard.mjs → wired=yes/paired=yes/armed=yes → catalog migrations preserving user model enablement; channel: required-path
check-e2e-destructive-tags.mjs → wired=yes/paired=yes/armed=yes → factory-reset E2E isolation tags; channel: required-path
check-e2e-readiness-contracts.mjs → wired=yes/paired=yes/armed=yes → fast E2E shard DB-readiness isolation; channel: required-path
enforce-coverage.mjs → wired=yes/paired=yes/armed=yes → coverage artifacts and per-package thresholds; contract: scripts/__tests__/enforce-coverage-artifact-contract.test.mjs
forbid-no-memo.mjs → wired=yes/paired=yes/armed=yes → React compiler escape directives; channel: required-path
mastra-stream-chunk-contract.mjs → wired=yes/paired=yes/armed=yes → Mastra chunk union coverage and observable unknown chunks; channel: required-path
model-catalog-migration-contract.mjs → wired=yes/paired=yes/armed=yes → dual migration registration and model remaps; channel: required-path
prune-stale-dist.mjs → wired=yes/paired=yes/armed=yes → stale dist artifacts pruned before non-cleaning tsc builds (global-turbo-cache poisoning class); wired into 35 package `build` scripts; contract: scripts/__tests__/prune-stale-dist.test.mjs
secret-scan.mjs → wired=yes/paired=yes/armed=yes → committed credential patterns; channel: required-path
turbo-boundaries.mjs → wired=yes/paired=yes/armed=yes → package-escaping imports + undeclared dependencies (`turbo boundaries`, verdict scoped to files git does not ignore, since the analyzer reads build output and cannot be told not to); Static-lane step `pnpm run boundaries`, ordered before any dist-producing step for scan cost; contract: scripts/__tests__/turbo-boundaries-gate.test.mjs (BST-967); channel: required-path
unit-shard-partition.mjs → wired=yes/paired=yes/armed=yes → exact Unit shard partition
verify-catalog-references.mjs → wired=yes/paired=yes/armed=yes → pnpm catalog consistency
verify-codecov-status-contract.mjs → wired=yes/paired=yes/armed=yes → Codecov status contexts remaining non-gating
verify-config-load-hash-coverage.mjs → wired=yes/paired=yes/armed=yes → Turbo config-load hash coverage
verify-eslint-warning-baselines.mjs → wired=yes/paired=yes/armed=yes → per-rule ESLint warning budgets remaining exact and error findings staying forbidden; contract: scripts/__tests__/eslint-warning-baseline-contract.test.mjs; channel: required-path
verify-guard-inventory.mjs → wired=yes/paired=yes/armed=yes → authoritative Warden guard classification and inventory integrity; channel: required-path
verify-lockfile-catalog-conformance.mjs → wired=yes/paired=yes/armed=yes → lockfile catalog conformance before dependency installation; channel: required-path
verify-mastra-schema-init-order.mjs → wired=yes/paired=yes/armed=yes → lazy initialization of Mastra memory-schema constants; channel: required-path
verify-minimum-release-age-exclusions.mjs → wired=yes/paired=yes/armed=yes → minimumReleaseAgeExclude entries expiring instead of becoming standing exemptions (publish dates recorded in scripts/minimum-release-age-exclusions.json); channel: required-path
verify-no-cross-chunk-cycles.mjs → wired=yes/paired=yes/armed=yes → acyclic emitted renderer chunk graph
verify-no-raw-nul-bytes.mjs → wired=yes/paired=yes/armed=yes → tracked source files remaining free of raw NUL bytes; channel: required-path
verify-no-source-cycles.mjs → wired=yes/paired=yes/armed=yes → acyclic renderer source module graph; channel: required-path
verify-no-vitest-worker-mutation.mjs → wired=yes/paired=yes/armed=yes → Vitest worker-global mutation; contract: scripts/__tests__/vitest-worker-global-mutation.test.mjs
verify-package-build-strategies.mjs → wired=yes/paired=yes/armed=yes → package build commands matching their declared output ownership; channel: required-path
verify-playwright-pin-sync.mjs → wired=yes/paired=yes/armed=yes → Playwright package and container pin parity
verify-tokenizer-asset-bundle.mjs → wired=yes/paired=yes/armed=yes → tokenizer data staying out of JavaScript bundles; contract: scripts/__tests__/tokenizer-asset-bundle-contract.test.mjs
verify-tsconfig-paths-match-registry.mjs → wired=yes/paired=yes/armed=yes → tsconfig paths matching source-alias registry
verify-tsup-build-invariants.mjs → wired=yes/paired=yes/armed=yes → tsup clean and declaration ownership invariants; channel: required-path
verify-workspace-src-aliases.mjs → wired=yes/paired=yes/armed=yes → test lanes resolving workspace imports from source
