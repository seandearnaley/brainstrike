## Risk Audit

Risk category: full-release-high-risk
Domains: ci-platform
Risk level: full
Overall status: missing-calibration
Selected budget: release-full-risk / 50m 30s of 60m 0s (within-target)

| Command | Owner | Samples | p50 | p95 | Budget | Evidence | Status |
|---|---|---:|---:|---:|---:|---|---|
| diff-check | tooling | 5 | 13ms | 13ms | 30.0s | measured | within-target |
| ci-script-tests | tooling | 5 | 275ms | 320ms | 2m 0s | measured | within-target |
| workflow-contracts | ci-platform | 5 | 266ms | 279ms | 3m 0s | measured | within-target |
| full-local-suite | release | 0 | - | - | 45m 0s | missing-calibration | missing |
