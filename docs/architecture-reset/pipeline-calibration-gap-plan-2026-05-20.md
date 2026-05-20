## Calibration Gap Plan

Minimum samples per command: 5
Selected missing samples: 5
Normal PR-risk missing samples: 0
Release-only missing samples: 5
Status: needs-samples

| Command | Owner | Selected | Samples | Missing | Estimated Remaining | Scope | Status |
|---|---|---|---:|---:|---:|---|---|
| full-local-suite | release | yes | 0 | 5 | 225m 0s | release-only | missing |
| ci-script-tests | tooling | yes | 5 | 0 | 0ms | normal | within-target |
| diff-check | tooling | yes | 5 | 0 | 0ms | normal | within-target |
| workflow-contracts | ci-platform | yes | 5 | 0 | 0ms | normal | within-target |
| db-tests | data-platform | no | 1 | 4 | 20m 0s | normal | calibrating |
