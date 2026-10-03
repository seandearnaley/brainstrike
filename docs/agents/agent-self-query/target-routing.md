# Explicit querySelf and lens targets

Supports the explicit database target contract in `../agent-self-query.md`.

## Scope — 2026-10-02

Live BST-1924 and its comments were read using UUID
`d8d8ea01-d918-4c8f-a39c-5a114bf90f21`. The ticket requires an explicit app/index
target and a declared target on every lens. This bounded contract layer starts
from synced integration `fa5a99abe439dfb7c4d507f3e5e09d8af9a0e88f`.

`QUERY_SELF_TARGETS` in the lens contract owns the shared literal inventory. The
strict querySelf Zod object requires that scalar enum for every mode. Provider
null normalization removes only optional fields; null target still fails.
No union, refinement, default target or SQL-based inference was introduced.

The lens grammar requires one target directive in the leading header. Empty,
unknown, absent and duplicate targets produce structured parse errors. A target
directive in the SQL body cannot satisfy the header. Existing placeholder,
parameter, malformed-description and body-cap controls retain their assertions;
their valid fixtures now supply the required header.

Five shipped telemetry/history lenses declare app. Canonical callers-hybrid
declares index. SQL bodies are unchanged in this layer. The existing PGlite caller
body is preserved at `packages/db/__tests__/fixtures/callers-hybrid-pglite.sql`
with an app header, and its golden runs through the real PGlite sandbox, binds
and graph-scoping checks. This retains hosted-web coverage until M6 while the
coordinator ports the canonical index lens to SQLite. The five app lens goldens
continue reading the shipped artifacts. The self-improvement signal's app-owned
SQL parity still passes because the SQL body is unchanged.

This layer does not implement desktop routing, SQL utility-process acquisition,
query result projections or the canonical caller SQL port. Those consumer changes
are composed by the coordinator. Requiring a target changes the input contract;
legacy consumer call sites must be migrated in that composition. Passing contract
tests alone does not demonstrate target execution in the running app.

## RED/GREEN

Before production edits, eight new lens controls failed because target directives
were ignored and declarations were absent from parsed results. New querySelf
positive/JSON-schema controls failed because target was unknown, and a separate
legacy-call control proved omission was still accepted. Required target parsing
and header validation make those controls pass without changing their assertions.

## Local validation

Mac arm64, macOS 27.0.1 (26A434), Node 26.8.2 through pnpm 11.15.0, Vitest 5.0.2:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec turbo run build --filter=@brainstrike/assistant-contract
pnpm --filter @brainstrike/assistant-contract type-check
pnpm --filter @brainstrike/assistant-contract test
```

The dependency lock is unchanged. Build passes, source/test TypeScript and strict
Effect diagnostics check 225 files with no errors or warnings. The complete
assistant-contract suite passes 1,107 tests in 75 files, including 57 parser/target
tests in the two directly changed contract files.

From `packages/db`:

```sh
pnpm exec vitest run --project unit __tests__/search-lens-callers-hybrid.test.ts __tests__/search-lens-estimator-calibration.test.ts __tests__/search-lens-experiment-outcome-correlation.test.ts __tests__/search-lens-run-outcome-tool-correlation.test.ts __tests__/search-lens-self-improvement-signal.test.ts __tests__/search-lens-token-spend-by-tool.test.ts --maxWorkers 2
```

All six real PGlite golden suites pass, 16 tests, including caller graph scoping,
fusion ordering and hostile bind rejection. Vite reports an existing config-loader
compatibility warning; no warning was suppressed.

The first desktop boundary run passed loader/context tests (36 tests) but could
not collect lens-mode tests because the fresh worktree had no secure-fs native
binary after the intentional ignore-scripts install. The native package is built
through its normal node-gyp build before repeating that run. This setup failure
is not counted as a passing suite.

```sh
pnpm --filter @brainstrike/secure-fs-native build
cd apps/desktop
pnpm exec vitest run src/__tests__/assistant-server/lens-loader.test.ts src/__tests__/assistant-server/query-self-lens-modes.test.ts src/__tests__/assistant-server/self-improvement-signal-context.test.ts
```

After the normal native build, all three desktop boundary files pass 43 tests.
These tests preserve loader visibility, legacy lens bind discipline and app-owned
signal parity; they do not establish new index execution. A direct standalone
desktop test type-check also fails on missing unbuilt workspace declarations in
this fresh checkout and is not counted as a type-check pass. The complete
consumer closure is required after target call-site migration is composed.

The normal commit hook then built and checked the affected dependency closure:
52 of 53 tasks passed, including assistant-contract and DB type-checks. Desktop
type-check failed on legacy querySelf test calls lacking the now-required target.
The secret scan (16 files) and formatter (7 files) passed. That commit did not
complete. No hook was bypassed and no default target or quarantine was added;
consumer call-site migration must be composed by its owner.

The coordinator selected a contract-only commit, preserving the two desktop
fixture diffs in `/tmp/brainstrike-target-lens-app-fixtures.patch` for consumer
composition. Normal hooks on that 14-file layer pass: secret scan, formatter,
commit message and all 13 affected type-check/build tasks (local Turbo cache hits
from the successful tasks above). No hook was bypassed. The isolated contract
commit does not claim desktop consumer type-check qualification: after its
dependencies were built, a direct desktop test check reports exactly 43 missing
target diagnostics across lens modes (7), tool integration (18) and tool tests
(18). All require the owner's consumer migration.

CI is disabled due to cost; validation must run locally. Full application
regression, actual index routing and real Windows qualification remain outside
this contract layer's local evidence.
