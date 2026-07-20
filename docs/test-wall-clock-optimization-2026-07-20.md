# Unit-test wall-clock optimization report — 2026-07-20

Measured baseline, root causes, and ranked opportunities for cutting CI unit-test wall-clock
time on standard GitHub runners. All timings are measured (CI run 29718226412 — the
worst-case "toolchain patch batch" PR where every package was affected — plus a local
`packages/db` run); estimates are marked as such.

## Measured baseline

- Workflow wall clock is entirely the **Unit** job: 42 min (05:03→05:45), while Build,
  Static, native jobs, and both E2E smokes all finish by ~09:30. Unit = the critical path.
- Inside the Unit job: "PR affected unit tests" step 32 min, "integration tests" step 9 min,
  both on **one runner** (`ubuntu-24.04-arm`, `.github/workflows/test.yml:101`), no sharding.
- Slowest vitest invocations in that step: **824s** (749s in test bodies), **593s**, 411s,
  400s, 356s, 346s, 228s, 197s… The two >590s runs are `packages/db` lanes and land last —
  the tail of the whole workflow.
- Across the ~35 other invocations, non-test overhead is large: `environment` (happy-dom/jsdom
  boot) 100–155s per big project, `import` 40–120s, `setup` up to 62s.
- Local `packages/db` run: 199s vitest duration / 3m32s wall at only **169% CPU** on a
  many-core machine — the suite is serialization-bound, not CPU-bound.

## Root causes (with citations)

### A. packages/db re-does everything per test
- ~**567 tests across 59 files boot a fresh PGlite and re-run all 60 migrations in
  `beforeEach`** (12 drizzle SQL + 48 custom migrations via `runMigrations`,
  `packages/db/src/drizzle/migrate.ts:533-587`). Only 6 files use the cheap
  `beforeAll`-shared pattern. Full run ≈ 550–600 cold WASM boots × 60 migrations.
- Zero reuse: no `TRUNCATE`-and-reuse anywhere in `packages/db/__tests__`, no
  `dumpDataDir`/`loadDataDir` template snapshot anywhere in the repo.
- **35 files use filesystem-backed tmp dataDirs** (`__tests__/test-data-dir.ts`) with
  `rm -rf` teardown where `memory://` would be equivalent.
- Worst offenders: `file-chunk-repository.test.ts` (50 boots), `managed-cache-batch.test.ts`
  (34), `drizzle-file-chunk-repository.test.ts` (33), `drizzle-migrate.test.ts` (32, re-runs
  the full chain ~22×), `search-thread-message-index.test.ts` (28), all 11 `job-queue*`
  files (66 boots).
- Duplicate suites double boot cost for overlapping coverage: `file-chunk-repository` vs
  `drizzle-file-chunk-repository` (83 combined boots), same for `file-record-repository`
  (17+27) and `embedding-sets-repository` (20+19) pairs.
- 53 per-test `{ timeout: 60_000 }` overrides across 14 migration test files are the smell
  signature of this: a schema assertion needing 60s means the bootstrap is the cost.
- Dead config: `TEST_PGLITE_MOCK: 'true'` (`packages/db/vitest.config.mts:74-76`) is read
  nowhere — the "unit (fast, PGlite mocks)" comment is false; every unit test boots real WASM.

### B. Serialization everywhere
- db unit lane: `pool: 'forks'`, `maxWorkers: 1` (`packages/db/vitest.config.mts:83,88`);
  142 test files run strictly one at a time.
- The 5 db lanes themselves run **sequentially** via a `for` loop + `spawnSync`
  (`packages/db/scripts/test-lanes.mjs:38-46`), each a fresh vitest boot.
- `apps/desktop` scripts hard-code `--pool=forks --maxWorkers=1 --no-file-parallelism`
  (`apps/desktop/package.json:171-173`) over 196 test files.
- `packages/agent` passes `--no-file-parallelism` on its cacheable `test` script;
  `packages/file-explorer-hooks` and `packages/file-explorer` hardcode `maxWorkers: 1`
  (Tinypool EPIPE workaround — Tinypool was removed in Vitest 4, so re-test).
- `packages/embeddings` / `packages/vector-management` use `pool: 'forks'` with no documented
  native-cleanup rationale (threads is the faster canonical choice per Vitest docs).
- CI turbo concurrency is hardcoded `--concurrency=4` / `=2` (test.yml:206-224) regardless of
  runner cores.

### C. One runner, no sharding, cache leaks
- No `--shard`, no job matrix; everything funnels into one Unit job.
- `db#test` is `cache: false` (`packages/db/turbo.json:47`) and always rebuilds
  `@brainstrike/utils` first — the heaviest lane never benefits from turbo caching.
- `globalDependencies` (`turbo.jsonc`) include `pnpm-lock.yaml`, `biome.json`, `turbo.jsonc`,
  root tsconfigs — any single edit busts **every** package's `test` cache.
- `topo` inputs deliberately don't exclude `**/*.test.*` — a test-only edit upstream
  invalidates all downstream dependents' cached tests (acknowledged in the comment).
- No turbo remote cache configured for CI.
- **Coverage instrumentation silently on for every PR unit run**: per-package
  `coverageEnabled = CI==='true' || COVERAGE==='true'`, and only the push path sets
  `COVERAGE: "false"` (test.yml:237,248) — the PR path pays V8 coverage overhead whose output
  is never uploaded.

### D. Wrong environments and real sleeps
- happy-dom is the default env via `packages/test-utils/src/vitest.base.ts:12` even for
  logic-only packages; the db unit lane runs on **jsdom** (`packages/db/vitest.config.mts:78`)
  though nearly all 142 files are pure repository/SQL logic. Measured environment cost:
  100–155s per big project in CI.
- 87 test files use `setTimeout`; **66 use real, unmocked delays**. Worst: 7 copy-pasted
  real-delay `waitFor` poll helpers in `packages/embeddings` integration tests
  (15s timeout / 25–50ms interval), literal sleeps of 3000ms/2000ms/1000ms in embeddings,
  4000–5000ms races in `apps/desktop` assistant-server tests, 250–600ms in
  `packages/file-system` parcel-watcher tests, ~500ms total in
  `packages/db/__tests__/drizzle-embedding-cache-repository.test.ts:86-361`.
- `packages/test-utils/src/test-timeouts.ts` doubles all timeouts in CI, amplifying slow suites.

## Ranked opportunities (canonical solutions first)

1. **PGlite template database (canonical, maintainer-endorsed).** Boot once per lane, run the
   60 migrations once, `dumpDataDir()` to memory, then `loadDataDir` per test file (plus
   truncate or transaction-rollback between tests within a file). PGlite docs:
   https://pglite.dev/docs/api. Replaces ~560 × 60-migration runs with 1 migration run +
   cheap snapshot loads. Also switch the 35 fs-backed files to `memory://`. Expected to
   collapse the 824s/593s lanes; this is the single biggest lever. (Exception: keep
   `drizzle-migrate.test.ts`/`migration-runner.test.ts` on the real path — they test the
   runner itself.)
2. **Shard the Unit job across runners.** Matrix N jobs; either split the turbo package graph
   by group or use `vitest --shard=i/N` + blob reporter within heavy packages. Everything else
   finishes by ~9 min, so 3–4 shards ≈ Unit job at ~10–12 min even before test-level fixes.
3. **Un-serialize the db lanes.** Run the 5 lanes concurrently (they're separate processes
   already) or raise `maxWorkers` within lanes once the template pattern removes the
   native-resource pressure that motivated forks/1-worker. Local run at 169% CPU shows
   immediate headroom.
4. **Turn coverage off on the PR unit path.** Add `COVERAGE: "false"` to the PR steps
   (test.yml:206-224) exactly as the push path does. Zero-risk, immediate win across every
   package (V8 collection + AST remap overhead).
5. **Right-size environments.** db unit lane jsdom→node; move logic-only suites in
   file-system, notes-vault, workspace-search, context-actions, commands, queue etc. off
   happy-dom (per-file `// @vitest-environment` pragma or split projects). Measured 100–155s
   per project of environment boot is on the table.
6. **Kill real sleeps.** Hoist one fake-timer-aware `pollUntil` into `packages/test-utils`
   (replacing 7 duplicated helpers in embeddings), replace literal `setTimeout` sleeps with
   `vi.waitFor`/fake timers (`vi.advanceTimersByTimeAsync`) in the 66 offending files.
7. **Audit serialization overrides.** desktop (`--maxWorkers=1 --no-file-parallelism`, 196
   files), agent, file-explorer(-hooks) `maxWorkers:1` (Tinypool workaround — Tinypool no
   longer exists in Vitest 4), embeddings/vector-management forks→threads.
8. **Turbo cache hygiene + remote cache.** Re-enable caching for `db#test` once lanes are
   deterministic-fast; narrow `globalDependencies` (biome.json should not bust test caches);
   exclude `**/*.test.*` from `topo` inputs; wire TURBO_TOKEN/TURBO_TEAM remote caching (or
   `rharkor/caching-for-turbo` to stay on GH cache).
9. **Modern Vitest levers.** `isolate: false` for hygienic node-env packages;
   Vitest 4.1 `experimental.viteModuleRunner: false` for node-env suites (skips Vite
   transform entirely — directly attacks the measured 40–120s import costs);
   `slowTestThreshold` + verbose reporter in CI for ongoing visibility.
10. **Cleanups.** Delete dead `TEST_PGLITE_MOCK` config + false comment; consolidate duplicate
    `X-repository` / `drizzle-X-repository` suites; drop blanket 60s per-test timeouts once
    bootstrap is fast; reconsider CI timeout doubling in `test-timeouts.ts`.

## Suggested sequencing

Quick wins first (4, then 2) are config-only and de-risk the rest. Then 1+3 as the flagship
db change (RED/GREEN: capture current lane timings via `scripts/profile-vitest-hotspots.mjs`
before/after). 5–7 are mechanical sweeps that parallelize well. 8–10 last.
