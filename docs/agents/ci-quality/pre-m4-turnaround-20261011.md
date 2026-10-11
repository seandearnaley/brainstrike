# Pre-M4 test turnaround handoff — 2026-10-11

CI is disabled due to cost; validation must run locally.

Use `codex/pre-m4-test-turnaround-20261011` as the test-turnaround layer after
M3. Its base is `d552870db`; M3's later `4e4a71a82` already corrects the
refused-host EPIPE fixture. Keep those M3 changes when composing the M4 base.
This branch does not qualify M3 or authorize an unverified integration merge.

## Usable changes

- `e0c1819a9`: remove the lock race's 250-second fixed waiting floor with a
  readiness/decision/release handshake; retain ten-round explicit stress.
  Separate six unchanged embedding soaks from routine correctness checks,
  reduce routine live-query repetition, reuse the canonical build cache,
  and provide `check:routine`, `check:release`, and `test:affected`.
- `7096af30d`: repair moved-owner/static validation references, wildcard build
  output validation, and logging's unit/integration partition.
- `6f55fd69a`: incremental desktop type checks, Vitest transform caching for
  file-import and assistant-service, the packaging assertion matching cached
  builds, current native-text fixture profile/read APIs, and local pnpm store
  settings preserved while Playwright receives CI semantics.

## Commands and actual evidence

During edits use relevant package tests or `pnpm test:affected` with
`TURBO_SCM_BASE` and `TURBO_SCM_HEAD` set to the reviewed base and candidate.
Use `pnpm check:routine` for composed routine acceptance. It must finish in
under 30 minutes. It omits complete desktop/agent-host integration matrices,
full E2E, coverage and deliberate stress. Use `pnpm check:release` for full
release acceptance; a routine pass is not a full-regression pass.

Every pnpm invocation uses `pnpm_config_verify_deps_before_run=error` and
`COREPACK_ENABLE_PROJECT_SPEC=0`. Runtime: Node 26.8.2, pnpm 11.15.0.
Mac mini: arm64, 12 logical CPUs, 32 GB, macOS 27.0.1.

Measured results:

- Windows D5 routine: 8 passed, 2.81 seconds total; ten-round stress: all ten
  eight-contender races passed, 5.09 seconds total.
- Windows static repair selection: 48 passed, 6.07 seconds. Normal commit
  hooks for `7096af30d`: 62 tasks passed, 3m40s.
- Mac desktop `pnpm --filter @brainstrike/desktop run type-check`: 28.076s
  cold, 16.901s warm; both pass, 800 selected tests and strict Effect diagnostics.
- Mac file-import unit run: cache disabled 4.310s, cold 4.350s, warm 3.696s;
  assistant-service: 2.353s, 2.325s, 1.474s. All pass; transform caching
  preserves isolated execution and does not cache test verdicts.
- Mac assistant-service integration after fixture repairs: 7 passed, 1 skipped
  in 11.01s. Query refusal passes; the query-success variant is skipped because
  this Node SQLite runtime disables memory accounting.
- Mac packaging assertion: passed in 1.177s wall time.

## Remaining acceptance work

No complete under-30-minute pass exists yet. The baseline profiling run on
`e0c1819a9` plus two boundary comments took 20m32.667s but was RED and its E2E
lanes never launched. It is not an acceptance time. Units consumed 13m11.563s
(76/77 Turbo tasks passed); desktop had one stale packaging assertion,
6,344 passing tests. Other failures: native-text fixture API drift, the
M3-corrected EPIPE, nine assistant-ui browser file import syntax errors, and
pnpm refusing the synthetic CI store-setting change. The fixes above address
these earlier failures; the browser repair below resolves its import problem.
Composed acceptance remains pending.

The next measured batch fixes browser setup (the web theme needs two asset
aliases; the hover fixture must explicitly park the real pointer), orders
state-store tests after native addon builds, and limits the agent package to
two workers when the root plan runs packages concurrently.

- `pnpm --filter @brainstrike/assistant-ui run test:browser`: 29 files passed,
  174 tests passed, one existing skip, 51.28s. Original UI assertions retained.
- Root routine unit command: 77/77 Turbo tasks passed, 45 cached, 667.170s.
  Desktop: 523 files and 6,345 tests passed, 501.38s. Agent: 237 files and
  3,197 tests passed, one skip, 156.62s versus baseline 245.69s.
- The measured candidate also capped DB, app-shell and app-state at two workers.
  Those changes were rejected: DB rose from 406.76s to 601.91s, app-shell from
  98.35s to 185.05s, and app-state from 9.84s to 21.88s. Their configs remain
  unchanged in the delivered batch. Peak sampled load fell from 69 to 40,
  but cache reuse and concurrent browser work differed; this is not a controlled
  whole-suite speedup claim. The final retained configuration still needs the
  composed routine run.
Live-query repetition changes still need runtime validation. Full release,
coverage and non-Mac qualification remain unverified.

Raw local evidence is retained alongside the Windows and Mac
`pre-m4-test-turnaround/brainstrike` worktrees in `../evidence/`, including
`profile-remaining.{json,log}`, `focused-optimizations.json`, and per-command
logs. The integration coordinator can read this thread directly; no further
routing through Sean is needed.