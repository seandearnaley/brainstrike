architecture-domain-boundaries.mjs → wired/paired/armed → cross-domain import boundaries (direction rules only; package-level escapes/undeclared deps are `turbo boundaries`' job — BST-971 division of labor)
architecture-domain-contract.mjs → wired/paired/armed → complete and valid architecture domain map
assistant-run-id-producer-guard.mjs → wired/paired/armed → single assistant runId producer (bootstrap-only run-event schema)
browser-events-literal-guard.mjs → wired/paired/armed → shared browser CustomEvent names
catalog-user-choice-guard.mjs → wired/paired/armed → catalog migrations preserving user model enablement
check-e2e-destructive-tags.mjs → wired/paired/armed → factory-reset E2E isolation tags
check-e2e-readiness-contracts.mjs → wired/paired/armed → fast E2E shard DB-readiness isolation
enforce-coverage.mjs → wired/paired/armed → coverage artifacts and per-package thresholds
forbid-no-memo.mjs → wired/paired/armed → React compiler escape directives
mastra-stream-chunk-contract.mjs → wired/paired/armed → Mastra chunk union coverage and observable unknown chunks
provider-catalog-key-order-guard.mjs → wired/paired/armed → provider-catalog.json object keys alphabetical at every depth
openrouter-pricing-audit.mjs → on-demand/paired/armed → OpenRouter catalog rows carrying the STANDARD route's BASE rate (not a `pricing.overrides` surge band, not a `min_prompt_tokens` long-context tier, not a `:batch`/`:free` variant route). Deliberately NOT in `lint:ci`: the fact lives upstream and OpenRouter re-prices roughly weekly, so a network gate would fail PRs for reasons outside them. Run `pnpm run audit:openrouter-pricing` when adding or re-pricing an openrouter row; the time-independent derivation it depends on IS pinned in the required Static lane by scripts/__tests__/openrouter-pricing-audit.test.mjs (BST-1705)
prune-stale-dist.mjs → wired/paired/armed → stale dist artifacts pruned before non-cleaning tsc builds (global-turbo-cache poisoning class); wired into 10 package `build` scripts; contract: scripts/__tests__/prune-stale-dist.test.mjs
secret-scan.mjs → wired/paired/armed → committed credential patterns
turbo-boundaries.mjs → wired/paired/armed → package-escaping imports + undeclared dependencies (`turbo boundaries`, verdict scoped to files git does not ignore, since the analyzer reads build output and cannot be told not to); Static-lane step `pnpm run boundaries`, ordered before any dist-producing step for scan cost; contract: scripts/__tests__/turbo-boundaries-gate.test.mjs (BST-967)
unit-shard-partition.mjs → wired/paired/armed → exact Unit shard partition
verify-catalog-references.mjs → wired/paired/armed → pnpm catalog consistency
verify-codecov-status-contract.mjs → wired/paired/armed → Codecov status contexts remaining non-gating
verify-config-load-hash-coverage.mjs → wired/paired/armed → Turbo config-load hash coverage
verify-mastra-schema-init-order.mjs → wired/paired/armed → lazy initialization of Mastra memory-schema constants
verify-minimum-release-age-exclusions.mjs → wired/paired/armed → minimumReleaseAgeExclude entries expiring instead of becoming standing exemptions (publish dates recorded in scripts/minimum-release-age-exclusions.json)
verify-no-cross-chunk-cycles.mjs → wired/paired/armed → acyclic emitted renderer chunk graph
verify-no-source-cycles.mjs → wired/paired/armed → acyclic renderer source module graph
verify-no-vitest-worker-mutation.mjs → wired/paired/armed → Vitest worker-global mutation
verify-playwright-pin-sync.mjs → wired/paired/armed → Playwright package and container pin parity
verify-tokenizer-asset-bundle.mjs → wired/paired/armed → tokenizer data staying out of JavaScript bundles
verify-tsconfig-paths-match-registry.mjs → wired/paired/armed → tsconfig paths matching source-alias registry
verify-tsup-build-invariants.mjs → wired/paired/armed → tsup clean and declaration ownership invariants
verify-workspace-src-aliases.mjs → wired/paired/armed → test lanes resolving workspace imports from source
