architecture-domain-boundaries.mjs → wired/paired/armed → cross-domain import boundaries (direction rules only; package-level escapes/undeclared deps are `turbo boundaries`' job — BST-971 division of labor)
architecture-domain-contract.mjs → wired/paired/armed → complete and valid architecture domain map
(turbo boundaries) → wired/paired/armed → package-escaping imports + undeclared dependencies; Static-lane step ordered before any dist-producing step; contract: scripts/__tests__/turbo-boundaries-gate.test.mjs (BST-967)
assistant-run-id-producer-guard.mjs → wired/paired/armed → single assistant runId producer (bootstrap-only run-event schema)
browser-events-literal-guard.mjs → wired/paired/armed → shared browser CustomEvent names
catalog-user-choice-guard.mjs → wired/paired/armed → catalog migrations preserving user model enablement
check-e2e-destructive-tags.mjs → wired/paired/armed → factory-reset E2E isolation tags
check-e2e-readiness-contracts.mjs → wired/paired/armed → fast E2E shard DB-readiness isolation
enforce-coverage.mjs → wired/paired/armed → coverage artifacts and per-package thresholds
forbid-no-memo.mjs → wired/paired/armed → React compiler escape directives
mastra-stream-chunk-contract.mjs → wired/paired/armed → Mastra chunk union coverage and observable unknown chunks
model-catalog-migration-contract.mjs → wired/paired/armed → dual migration registration and model remaps
secret-scan.mjs → wired/paired/armed → committed credential patterns
unit-shard-partition.mjs → wired/paired/armed → exact Unit shard partition
verify-catalog-references.mjs → wired/paired/armed → pnpm catalog consistency
verify-codecov-status-contract.mjs → wired/paired/armed → Codecov status contexts remaining non-gating
verify-config-load-hash-coverage.mjs → wired/paired/armed → Turbo config-load hash coverage
verify-mastra-schema-init-order.mjs → wired/paired/armed → lazy initialization of Mastra memory-schema constants
verify-no-cross-chunk-cycles.mjs → wired/paired/armed → acyclic emitted renderer chunk graph
verify-no-source-cycles.mjs → wired/paired/armed → acyclic renderer source module graph
verify-no-vitest-worker-mutation.mjs → wired/paired/armed → Vitest worker-global mutation
verify-playwright-pin-sync.mjs → wired/paired/armed → Playwright package and container pin parity
verify-tokenizer-asset-bundle.mjs → wired/paired/armed → tokenizer data staying out of JavaScript bundles
verify-tsconfig-paths-match-registry.mjs → wired/paired/armed → tsconfig paths matching source-alias registry
verify-tsup-build-invariants.mjs → wired/paired/armed → tsup clean and declaration ownership invariants
verify-workspace-src-aliases.mjs → wired/paired/armed → test lanes resolving workspace imports from source
