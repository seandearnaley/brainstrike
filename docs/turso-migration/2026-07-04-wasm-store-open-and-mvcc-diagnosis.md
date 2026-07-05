# Turso Browser-WASM Bootstrap Probe Failures — Diagnosis

Date: 2026-07-04 · Branch: `feature/turso-migration` · Read/research/repro only, no production changes.

## TL;DR

| Probe | Environment | Symptom | Root cause | Fixed by upgrade? |
|---|---|---|---|---|
| `store.open` | Fresh Linux CI Chromium | `TypeError: … (reading 'whenLoaded')` | Unguarded worker deref in emnapi async-work-pool init (`initWorkers`), reached through turso's single-shared-worker WASM glue at `connect()` → `initThreadPool()` | No published version guards it (0.6.1 and 0.7.0-pre.17 ship the same emnapi pattern) |
| `store.open` | Local macOS (this machine, this session) | `Failed to fetch dynamically imported module …/deps/@tursodatabase_database-wasm_vite.js` | **Two stacked local issues**: (a) `optimizeDeps.exclude` in `packages/db/vitest.config.mts` is top-level only — inline projects don't inherit it, so the browser project optimizes the dep anyway; (b) the local `node_modules` is a broken/stale install: `@tybys/wasm-util@0.10.1` is in `pnpm-lock.yaml` but absent from disk, so the optimized bundle's bare import 500s | `pnpm install` heals (b); config fix needed for (a) |
| `primary-store.mvcc` | macOS Chromium (REPRODUCED) | `RuntimeError: unreachable` — a **Rust panic**: `panicked at bindings/javascript/src/lib.rs:677:22: already mutably borrowed: BorrowError`; the wasm instance is wedged afterwards (subsequent statements hang) | `PRAGMA journal_mode='mvcc'` in the WASM build re-enters the napi `Statement` RefCell during the synchronous MVCC bootstrap. **Reproduced identically on 0.7.0-pre.17 (latest published)** at `lib.rs:704:22` | **No.** MVCC in browser WASM is broken upstream at every published version |

**Authoritative MVCC-in-WASM verdict: native-only today.** Three independent blockers, each individually fatal in the browser:
1. The JS-binding panic above (reproduced on 0.6.1 stable AND 0.7.0-pre.17, 2026-06-25).
2. Even if the panic were fixed, `open_mv_store` opens a `<db>.db-log` logical-log file (`core/storage/journal_mode.rs`), but the browser OPFS VFS only pre-registers `<name>` and `<name>-wal` (`bindings/javascript/packages/wasm/promise-default.ts` `connect()`, same on `main`); unregistered paths hard-fail: `browser.rs::open_file` → `-404` → `InternalError("unexpected path {path}: files must be created in advance for OPFS IO")`.
3. Upstream has **zero** MVCC/journal_mode coverage in the browser package test suite (`bindings/javascript/packages/wasm/promise.test.ts` — big-schema, vector, explain only), and `docs/manual.md` labels MVCC "experimental… Many features may not work, work incorrectly, and/or cause a panic."

Upstream PR [#7349](https://github.com/tursodatabase/turso/pull/7349) ("Remove blocking IO from mvcc bootstrap and recovery paths", merged 2026-06-09 — *after* v0.6.1 was cut 2026-05-22) confirms the MVCC open path never worked on WASM ("no longer hangs on backends without a synchronous IO pump (e.g. WASM, where `io.step()` is a no-op)") — and my pre.17 repro shows even that fix does not make the pragma survive in the browser build.

---

## 1. Code under test (what the probes require)

- **Seam**: `packages/db/src/turso/browser-wasm-client.ts:22` — `await import('@tursodatabase/database-wasm/vite')` then `connect(path)`. The package's `/vite` export is conditional: `"development" → dist/promise-vite-dev-hack.js` (what Vitest's dev-mode resolution picks), `"default" → dist/promise-default.js`.
- **Bootstrap**: `packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts`
  - `store.open` (line 143): `openDatabase(options.dbPath)`.
  - `primary-store.mvcc` (lines 148–151): runs `PRAGMA journal_mode = 'mvcc'`, re-queries `PRAGMA journal_mode`, and `assertTursoMvccJournalMode` (line 401) throws unless the row returns literally `'mvcc'`. Mirrors the desktop hard requirement in AGENTS.md.
  - All 10 checks are `required: true`; any throw fails the report closed via `failProfileBootstrapReport` with `code: 'turso_browser_wasm_bootstrap_failed'`. The error handling stores `error.message` verbatim as the failed check's `message` — which is how the raw wasm trap text `unreachable` and the emnapi TypeError text end up as check messages.
  - Note: the execution client built here uses `BEGIN CONCURRENT` for `transaction()` (line 245) — only valid under MVCC, relevant to the recommendation below.
- **Smoke test**: `packages/db/__tests__/turso-browser-wasm-bootstrap.browser.test.ts` — currently a *fails-closed proof*, not a readiness proof. It encodes the two observed failure signatures as accepted outcomes:
  - lines 54–66: failure phase `opening-store` with `store.open` message containing `"reading 'whenLoaded'"` (the Linux CI signature — i.e. `TypeError: Cannot read properties of undefined (reading 'whenLoaded')`),
  - lines 68–80: failure phase `probing-capabilities` with `primary-store.mvcc` message exactly `'unreachable'` (the macOS signature).
- **Runner**: `packages/db/vitest.config.mts` browser project (Playwright Chromium, headless, COOP/COEP headers, 30s timeout), invoked via `pnpm --filter @brainstrike/db test:browser` / `vitest run --project browser`. Note: upstream turso's own browser suite uses `testTimeout: 120_000` — they know worker/wasm startup is slow.

## 2. Reproduction record (exact commands and output)

### 2a. Repo smoke test (macOS, this machine)

```
cd packages/db && pnpm vitest run --project browser __tests__/turso-browser-wasm-bootstrap.browser.test.ts
```
Result: test FAILS — but with a **third** signature neither branch accepts:
```
store.open failed: "Failed to fetch dynamically imported module:
http://localhost:63315/node_modules/.vite/vitest/ef98…/deps/@tursodatabase_database-wasm_vite.js?v=…"
```
Persists after `rm -rf packages/db/node_modules/.vite`. Server-side cause (captured with `DEBUG='vite:optimize-deps,vite:deps,…'`):
```
[vite] Internal server error: Failed to resolve import "@tybys/wasm-util" from
"node_modules/.vite/vitest/…/deps/@tursodatabase_database-wasm_vite.js?v=…". Does the file exist?
```
Two stacked causes:
1. **Inert exclude**: `optimizeDeps.exclude: ['@tursodatabase/database-wasm', '@tursodatabase/database-wasm-common']` sits at the **top level** of `vitest.config.mts` (lines 61–63). Vitest inline projects do not inherit top-level Vite options (the config's own comment says this for `resolve.alias`, and declares aliases per-project — but `optimizeDeps` was never copied into the browser project, lines 98–134). So the browser project optimizes the dep after all, and the esbuild-optimized 13 MB bundle leaves `@tybys/wasm-util` (a dep of `@napi-rs/wasm-runtime`, used by `@tursodatabase/database-wasm-common`) as a bare unresolved import.
2. **Broken local install**: `@tybys/wasm-util@0.10.1` is present in `pnpm-lock.yaml` (packages entry line 7342; snapshot under `@napi-rs/wasm-runtime@1.0.7` line 15452) but **absent from `node_modules/.pnpm` on disk**, and `.pnpm/@napi-rs+wasm-runtime@1.0.7/node_modules/` contains no dependency links at all. Verified that a **fresh** `pnpm install` of `@tursodatabase/database-wasm@0.6.1` in an isolated project materializes `@tybys/wasm-util` and links wasm-runtime's deps correctly — so this is stale/interrupted local install state, not a lockfile or pnpm-resolution bug. CI's fresh install would have it (consistent with CI failing *later*, at runtime inside the successfully-loaded module).

⇒ On a healed install the exclude is still inert, but resolution of `@tybys/wasm-util` from the deps bundle would then succeed (it becomes reachable via pnpm's hidden hoist), so the store would open on macOS and the smoke would land in the `probing-capabilities`/`unreachable` branch — matching the encoded expectations.

### 2b. Isolated real-Chromium repro of the MVCC probe (REPRODUCED)

Harness: `scratchpad/turso-wasm-repro/` — `serve.mjs` (static server with COOP/COEP `require-corp`/`same-origin` headers, serving the package's self-contained `/bundle` entry `bundle/main.es.js`, which avoids the dep-optimizer/`@tybys` variable entirely) + `index.html` (runs the same probe sequence as the bootstrap) + `drive.mjs` (Playwright Chromium 1.59.1, headless).

**`@tursodatabase/database-wasm@0.6.1`** (the installed version):
```
open:    ok
SELECT 1: [{"one":1}]
mvcc:    ERROR name=RuntimeError message=unreachable
         stack=RuntimeError: unreachable at wasm://wasm/024410a6:wasm-function[8866]…
console: thread '<unnamed>' panicked at bindings/javascript/src/lib.rs:677:22:
         already mutably borrowed: BorrowError
after:   the follow-up "PRAGMA journal_mode = 'wal'" probe HANGS (driver timeout);
         db.close() never reached — the wasm instance is wedged by the trap
```
This is byte-for-byte the smoke test's encoded macOS signature (`message: 'unreachable'`), now with the underlying panic surfaced: `lib.rs:677` at v0.6.1 is `Statement::statement_handle`'s `self.stmt.borrow()` — a RefCell borrow that panics because the synchronous MVCC bootstrap (`op_journal_mode` Finalize → `open_mv_store` + `mv_store.bootstrap(conn)` in `core/vdbe/execute.rs` at v0.6.1) re-enters statement machinery while the outer `Statement::run` still holds `borrow_mut`. Exactly the class of blocking-IO re-entrancy PR #7349 describes.

**`@tursodatabase/database-wasm@0.7.0-pre.17`** (newest published, 2026-06-25; fetched via `npm pack`, same harness, different wasm hash `029cfe56` confirming the new binary ran):
```
mvcc:    ERROR name=RuntimeError message=unreachable
console: thread '<unnamed>' panicked at bindings/javascript/src/lib.rs:704:22:
         already mutably borrowed: BorrowError
```
Same panic, shifted line. **A package upgrade does not fix the MVCC probe.**

### 2c. Linux CI `whenLoaded` failure (not reproducible on macOS; mechanism identified from shipped code)

The error text encoded in the smoke (`…reading 'whenLoaded'`) is a TypeError dereferencing an **undefined worker**. Trace through the shipped glue:

- `connect()` (`dist/promise-vite-dev-hack.js`) → `init()` → `await initThreadPool()`.
- turso's `init_thread_pool` (`bindings/javascript/src/browser.rs:20-25`) is "put a no-op AsyncTask on the thread pool and force emnapi to allocate web worker" — i.e. it exercises emnapi's **async-work pool** (`asyncWorkPoolSize: 1` in `@tursodatabase/database-wasm-common` `setupMainThread`).
- emnapi's `initWorkers` (both `@emnapi/core@1.8.1` on local disk and `@emnapi/core@1.10.0` per the lockfile snapshot; verified in 1.10.0 `dist/emnapi-core.js` around line 2985) contains an **unguarded fallthrough**:
  ```js
  var index = emnapi_async_worker_create(1, …);
  if (index < 0) { worker = emnapiAWMT.pool[-index - 1]; if (worker) return worker.whenLoaded; }
  index >>>= 0;                       // negative index becomes a garbage offset
  var tid = view.getInt32(index + 20, true);
  worker = PThread.pthreads[tid];     // undefined for a garbage/unregistered tid
  return worker.whenLoaded;           // TypeError: Cannot read properties of undefined (reading 'whenLoaded')
  ```
  If `emnapi_async_worker_create` fails or the tid lookup races the worker registration, the deref explodes with precisely the CI message. The surrounding design is fragile by construction: `setupMainThread` creates **one** `Worker` and `onCreateWorker()` returns that same instance for every allocation, so any second spawn/pool interaction operates on shared state.
- Why Linux CI only: CI runners are slower (worker module + 13 MB dev-served code + wasm compile in flight when the pool init dereferences), run under `--no-sandbox --disable-dev-shm-usage`, and CI is the only environment that has a *complete* install (so it reaches this runtime path at all). macOS with the `/bundle` entry opens the store reliably (2b), so the failure is environment/timing-sensitive, not deterministic per-platform.
- No upstream issue exists for this yet (GitHub search `repo:tursodatabase/turso whenLoaded` → 0 results; `"thread pool is exhausted"` → 0 results). Related upstream WASM-I/O fragility: issue [#6454](https://github.com/tursodatabase/turso/issues/6454) (WAL short reads on wasm open/close).

## 3. Version audit

| Package | Installed | Latest stable | Latest published |
|---|---|---|---|
| `@tursodatabase/database-wasm` | 0.6.1 | **0.6.1** | 0.7.0-pre.17 (2026-06-25) |
| `@tursodatabase/database` (native, desktop) | 0.6.1 | 0.6.1 | 0.7.0-pre.17 |
| `@tursodatabase/database-wasm-common` | 0.6.1 | 0.6.1 | — |
| `@napi-rs/wasm-runtime` (via wasm-common) | 1.0.7 | — | — |

We are on the newest stable; the only newer bits are 0.7.0 pre-releases. Post-0.6.1 changes relevant to these failures: #7349 (non-blocking MVCC bootstrap for WASM, in v0.7.0-pre.7+, **insufficient** per 2b), #7500 (MVCC sync engine, open), #7137 (MVCC-safe AUTOINCREMENT). Nothing in the 0.7.0-pre line touches the `whenLoaded` glue or registers the `.db-log` in the browser VFS (checked `promise-default.ts` and `wasm-common/index.ts` on `main`).

## 4. Recommendations

### A1 — Linux/store-open (`whenLoaded`) + local store-open (dep optimizer)

1. **Heal the local install** (no PR): run `pnpm install` at the repo root; verify `node_modules/.pnpm/@tybys+wasm-util@0.10.1` exists. This restores lockfile↔disk parity that the current machine has lost.
2. **Make the exclude real** (tiny PR): move `optimizeDeps: { exclude: ['@tursodatabase/database-wasm', '@tursodatabase/database-wasm-common'] }` into the **browser project's** inline config in `packages/db/vitest.config.mts` (same reason the aliases are duplicated there). This removes the dep optimizer from the WASM path entirely so the package's own `promise-vite-dev-hack.js` (built for exactly this dev-server scenario) is served untouched, and store-open failures become *runtime* signal instead of bundler noise.
3. **Classify + bound the worker-init race** (small PR): in `runTursoBrowserWasmBootstrap`, treat a `store.open` TypeError matching the emnapi worker-init signature as a *retryable startup fault*: bounded retries (e.g. 2, with logged diagnostics and a fresh `connect()`), then fail closed with an explicit `store.open` message naming the upstream fragility. This is not a silent fallback — every retry is logged and the terminal state is still fail-closed. Rationale: the fault is a startup race in vendor glue, the exact class where one bounded retry is the canonical mitigation. Also consider raising the browser-project `testTimeout` toward upstream's 120 s so slow CI worker startup doesn't masquerade as new failure modes.
4. **File the upstream issue** (docs/ledger PR + GitHub issue on `tursodatabase/turso`): unguarded `worker.whenLoaded` deref in the async-work pool init path reached via `initThreadPool()`; include the `initWorkers` fallthrough analysis and CI environment details. None exists today.

### A2 — MVCC probe: propose the documented browser journal-mode contract (WAL, fail-closed)

**Do not wait for upstream.** MVCC in WASM is not "lands in version X": the latest published build still panics (2b), the browser VFS cannot open the MVCC logical log even on `main`, upstream has no browser MVCC tests, and MVCC overall is documented experimental. Recommendation:

- Keep the desktop invariant untouched (native Turso hard-requires `journal_mode='mvcc'` + `BEGIN CONCURRENT`, per AGENTS.md TURSO RUNTIME INVARIANT).
- For the `{engine:'turso', host:'browser', persistence:'opfs'}` report **only**, replace the `primary-store.mvcc` check with an explicit `primary-store.journal-mode` contract: require `PRAGMA journal_mode` to report `wal` (Turso WASM's supported persistent mode), record `journalMode: 'wal'` and `concurrentWrites: false` as first-class report capabilities, and fail closed on anything else. Never issue `PRAGMA journal_mode='mvcc'` in the browser (it doesn't just fail — it wedges the whole wasm instance, poisoning every later check including `store.close`).
- Consequential fix in the same contract: the browser execution client's `transaction()` currently emits `BEGIN CONCURRENT` (`turso-browser-wasm-bootstrap.ts:245`), which is MVCC-only per upstream docs — under the WAL contract both `transaction` and `exclusiveTransaction` must use plain `BEGIN` (single-writer semantics), and the report's search-ownership message should state single-writer explicitly.
- Track upstream for a future opt-in: watch #7500 (MVCC sync), the `.db-log` OPFS registration gap, and the `lib.rs` BorrowError panic (file it — no issue exists). Re-probe MVCC behind an explicit experiment flag only after upstream ships browser MVCC tests.
- Update AGENTS.md (TURSO RUNTIME INVARIANT) + `docs/turso-migration/migration-ledger.md` to record the browser-runtime journal-mode contract, per the "when changing this flow" rule.

## 5. Slice plan (failing-test-first, PR-sized)

1. **`fix(db): apply optimizeDeps exclusions to the vitest browser project`**
   - Failing state first: current browser smoke on a healed install still routes through `/deps/` (assert via a config unit test that the browser project's `optimizeDeps.exclude` contains both packages — mirrors the existing alias-duplication comment pattern).
   - Change: duplicate `optimizeDeps` (and `define.'process.env.NODE_DEBUG_NATIVE'`, same inheritance trap) into the browser project.
   - Proof: `pnpm --filter @brainstrike/db test:browser` no longer produces the `Failed to fetch dynamically imported module` variant on macOS.
2. **`feat(db): classify and bound turso browser store-open worker-init faults`**
   - Failing test first (unit, jsdom lane, injected `openDatabase`): (a) throws the `whenLoaded` TypeError once then succeeds → report reaches later checks with a logged retry diagnostic; (b) throws persistently → fails closed at `store.open` with a message naming the emnapi worker-init fault. Register the test in BOTH `test-lanes.mjs` and `coverage-lanes.mjs` (two registries).
   - Change: bounded retry + failure classification in `runTursoBrowserWasmBootstrap`; raise browser `testTimeout` to 120 s.
3. **`feat(db): browser turso journal-mode contract (wal, fail-closed)`**
   - Failing test first: rewrite `turso-browser-wasm-bootstrap.browser.test.ts` from a fails-closed proof into a readiness proof — expects phase `ready`, `journalMode: 'wal'`, `concurrentWrites: false`, and **no** MVCC pragma issued (spy via injected `openDatabase` in the unit twin; real path in the browser smoke). Unit twin keeps a desktop-shaped case proving the mvcc requirement is untouched for non-browser runtimes.
   - Change: replace `primary-store.mvcc` with `primary-store.journal-mode` for the browser runtime; switch the browser exec client to plain `BEGIN`; thread the new capabilities through `ProfileBootstrapReport`.
   - Docs in the same PR: AGENTS.md invariant note + migration-ledger entry (living-document rule).
4. **`docs(turso): upstream tracking + repro records`**
   - File the two upstream issues (BorrowError MVCC panic with the 2b repro; `whenLoaded` deref with the 2c analysis), link them from the ledger, and record the "MVCC is native-only until upstream ships browser MVCC tests + `.db-log` OPFS registration" decision with the version-watch list (#7349 in 0.7.0-pre.7+, #7500 open).
5. *(After 1–3 land)* **`test(db): re-enable browser smoke as a required readiness gate`** — flip the lane from accepted-failure to green-required once CI runs the WAL-contract bootstrap end to end.

## Appendix: evidence index

- `packages/db/src/turso/browser-wasm-client.ts:22` — `/vite` entry import.
- `packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts:143-151, 245, 401-421` — probes, BEGIN CONCURRENT, mvcc assert.
- `packages/db/__tests__/turso-browser-wasm-bootstrap.browser.test.ts:54-80` — encoded dual failure signatures.
- `packages/db/vitest.config.mts:61-63` (inert exclude), `:98-134` (browser project), `:9-13` (inheritance comment).
- `pnpm-lock.yaml:7342, 15448-15452` — `@tybys/wasm-util@0.10.1` present in lockfile; absent on disk (`ls node_modules/.pnpm | grep tybys` → nothing).
- `node_modules/.pnpm/@tursodatabase+database-wasm@0.6.1/...package.json` — `/vite` conditional exports (`development` → dev-hack).
- `@tursodatabase/database-wasm-common@0.6.1 dist/index.js` — `setupMainThread` single shared worker + `onCreateWorker(){return worker}`; OPFS registers only `name`/`name-wal`.
- Upstream (github.com/tursodatabase/turso): `bindings/javascript/src/browser.rs:20-25` (init_thread_pool no-op AsyncTask), `:129-153` (open_file −404 "files must be created in advance for OPFS IO"); `bindings/javascript/src/lib.rs:677` @v0.6.1 (`statement_handle` borrow — panic site); `core/vdbe/execute.rs` @v0.6.1 `op_journal_mode` Finalize → `open_mv_store` + `mv_store.bootstrap`; `core/storage/journal_mode.rs` @v0.6.1 (`.db-log`); `packages/wasm/promise.test.ts` @main (no MVCC coverage); `docs/manual.md` (MVCC limitations); PR #7349 (merged 2026-06-09); releases: v0.6.1 = 2026-05-22, v0.7.0-pre.17 latest.
- `@emnapi/core@1.10.0 dist/emnapi-core.js` (~line 2985) — unguarded `PThread.pthreads[tid].whenLoaded` with `index >>>= 0` fallthrough.
- Repro harness + raw outputs: `scratchpad/turso-wasm-repro/` (serve.mjs, index.html, drive.mjs), `scratchpad/database-wasm-0.7.0-pre.17/`, `scratchpad/pnpm-install-test/`.
