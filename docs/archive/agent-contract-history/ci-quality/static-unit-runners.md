# Static on arm64, Unit fan-in on slim — evidence

Supports `docs/agents/ci-quality.md` § "Static runs on arm64; the Unit fan-in
runs on slim" (Series C R9b/R10). Read this before proposing to move `static`
or the `unit` fan-in to another runner class. The contract holds the rules;
this file is the record of why.

The probe below is historical: it measured the Static job as it was then, which
included the `test:integration` suites. Those now run in `unit-shard`.

Corrected after extraction (verified against `.github/workflows/test.yml` and
`scripts/__tests__/ubicloud-runner-contract.test.mjs`): `native-windows` runs
for every admitted head with no affected gate; the last sentence said otherwise.

`static` in `test.yml` runs on `ubuntu-24.04-arm`, not `ubuntu-latest` (x64).
arm64 runners became available
for private repos on 2026-01-29 and cost 37% less per minute than x64. Probe P1
measured this specific: `pnpm install --frozen-lockfile` (the native-deps/node-gyp set,
the main risk), lint, script tests, secret scan, and the 6 `cache: false`
`test:integration` suites (real PGlite, embeddings — the heaviest,
native-dependent work in the workflow) all genuinely ran and passed on
arm64. Wall-clock was AT PARITY with x64 (~3.0m either arch) — arm64 is
**not** faster here, only cheaper per minute; do not claim a speedup.

The `unit` fan-in performs no install, build, or test: it reads the matrix
result and normally completes in about three seconds. The 2026-08-21..28 cost
audit found 609 rounded ARM minutes ($3.05 list price) for that result check.
It now runs on GitHub `ubuntu-slim`, preserving the exact required `Unit` check
while lowering the one-minute rounding rate to $0.002. `native-windows` stays
on GitHub's `windows-latest` runner and is allocated for every admitted head
(always-on after quiet-head admission; `ubicloud-runner-contract.test.mjs` guards it).
