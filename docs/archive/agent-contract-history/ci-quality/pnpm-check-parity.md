# `pnpm check` parity — evidence

Supports `docs/agents/ci-quality.md` § "`pnpm check` is a mirror of test.yml,
not a second CI definition" (BST-1009, BST-1050, BST-836, BST-967). Read this
before changing `scripts/check.mjs`, its flags, the parity comparator in
`scripts/__tests__/check-ci-parity.test.mjs`, or where `CI=true` is applied.
The contract holds the rules; this file records the divergent plan it replaced
and why the comparator compares commands. Timeout-multiplier history is in
`test-timeout-multiplier.md`.

`scripts/check.mjs` is the local gate. It has ZERO workflow references and is
not in `lefthook.yml`, so it is pure human/agent convenience — which is exactly
why a false green there is dangerous: it is the thing people cite as "CI-
equivalent" before pushing.

It was one. The pre-BST-1009 plan ran `lint-all`, `build`, `type-check`,
`test:coverage:split`, `coverage:enforce`, `test:browser`,
`test:e2e:functional`, `test:e2e:desktop` — a second, divergent definition of
CI whose divergences were silent:

- `test:coverage:split` → `test:coverage:base` =
  `pnpm -r --filter '!@brainstrike/db' --filter '!@brainstrike/embeddings' run test:coverage`.
  **A green `pnpm check` had never run `packages/db`** — the largest suite in
  the repo and the one turbo task that can never be replayed from a cache hit.
- It omitted three Static gates: `pnpm secrets:scan`, `pnpm exec turbo
  boundaries`, and **`pnpm test:scripts`** — i.e. the
  gate that runs the guard-script tests did not run in the local gate that
  guard scripts exist to protect (BST-836 again, one level up).
- `lint-all` = `pnpm lint && pnpm format`, which **writes** (`biome check .
  --fix`); CI's `lint:ci` is read-only. A gate must not rewrite the tree it is
  judging.
- It ran whole E2E suites where CI runs the smoke *lanes*.

The rewrite conforms to `test.yml` rather than paraphrasing it. Rules that must
survive future edits:

- **Turbo-native where CI is turbo.** The unit lanes are
  `turbo run test --concurrency=4` then `turbo run test:integration
  --concurrency=2` under `TURBO_TEST_MODE=unit`, unfiltered — CI's nine Unit
  shards are an affected-set PARTITION of those same two tasks, and unfiltered
  is their union. Never reintroduce a `pnpm -r` filter list here; that is the
  shape that drifted.
- **Read-only lint by default.** `--fix-lint` is the explicit opt-in to the
  writing chain.
- **The install is `--frozen-lockfile`**, matching
  `.github/actions/setup-workspace`. A plain `pnpm install` silently UPDATES
  `pnpm-lock.yaml` when a workspace manifest has drifted from it and continues
  green, while CI rejects that same input — a false green in the install step
  of the script that exists to stop false greens.
- **The Playwright lanes run under `CI=true`, and nothing else does.** Both
  `playwright.config.ts` files branch on `config.isCI` for `forbidOnly`,
  `fullyParallel`, `globalTimeout`, `retries`, `workers`, `reporter`, the
  Chromium launch args and `trace`, and the `e2e/utils` helpers key their wait
  budgets off `CI` too — so without it a stray `test.only` in an `@web-smoke`
  test passes the lane locally while the required Web E2E job rejects the same
  source. Playwright's `--forbid-only` flag was considered and REJECTED: it
  repairs one of ~10 CI-conditioned divergences. **Do not hoist `CI` to the
  whole run (BST-1050)**: it would change the WORKLOAD of the unit lanes, not
  just their environment — `getTimeoutMultiplier()` returns 2 under `CI`, and
  `packages/vector-management`'s base vitest config switches on a 70% line
  threshold when `CI === 'true'`. It belongs to the five Playwright
  invocations (three smoke lanes, plus the two full-regression lanes under
  `--full`) and nowhere else; the parity test asserts both halves.
- **`--full` is additive**, not a swap: the required-check mirror plus
  `nightly-coverage.yml`'s threshold gate and the full E2E regression lanes.
  `--fast` drops only the lanes CI fans out to separate runners (Browser tests,
  E2E) and reports those omissions in the banner. `--fast --full` is rejected
  because it would otherwise request contradictory E2E selections; `--no-coverage`
  is valid only with `--full`. Coverage is deliberately NOT in the default
  plan, because it is not a required check.
- **`--continue=dependencies-successful` (mirroring the Build job) changes
  turbo's scheduling, not its exit code.** `runStep()` rejects on ANY non-zero
  exit and the orchestrator is fail-fast, so a `--continue` run still fails the
  whole command. A test proves this with a real `exit 3`.
- **A CI gate that is not run locally must be DECLARED**, never quietly
  dropped. `CI_GATES_NOT_RUN_LOCALLY` in `check.mjs` names platform exclusions;
  `uncoveredCiGates()` adds any gates omitted by the selected mode flags before
  printing the banner. The static list currently holds exactly the two native
  jobs (`native-windows`: needs a Windows host; `native-electron`:
  electron-builder packaging for the runner's own platform, non-required,
  ~25 min).

`scripts/__tests__/check-ci-parity.test.mjs` (Static job, via
`pnpm test:scripts`) holds the line. It parses every `run:` step in `test.yml`
and requires each to be (a) mapped to a plan step id `buildPlan()` emits,
(b) named in `CI_GATES_NOT_RUN_LOCALLY` with a reason, or (c) listed as runner
plumbing in its `PROVISIONING_STEPS` set. Anything else fails, so a NEW CI gate
cannot be silently missed.

**It compares COMMANDS, not names**, and that distinction is the contract.
`gateInvocations()` reduces both the CI `run:` text and the mapped plan
command(s) to the set of pnpm scripts, turbo tasks and node scripts each
actually invokes (splitting on newlines/`&&`/`;`, seeing through
`pnpm --filter X <script>`, `pnpm turbo run`, this repo's
`run-turbo-command.mjs -- run`, and a `dbus-run-session --` prefix), then
requires the CI set to be a subset of the plan set. Asserting only that a
mapped id still exists was itself the drift class: `pnpm test:scripts` could
become `pnpm test:scripts && pnpm run new-gate` with the contract still green
and the new gate running in CI and nowhere else. A CI step whose token set
comes back EMPTY fails unless it is declared in `SHELL_GATE_STEPS` naming the
test that covers its drift (only `build › Validate CSS bundle` today, covered
by the byte-floor/duplicate-layer comparison).

Per BST-836 every part of that is control-tested — a synthetic `check.mjs` with
a gate deleted from the plan; another with an exclusion entry deleted; a
MUTATED `test.yml` whose `Script tests` step gains `&& pnpm run
new-uncovered-gate`; and the parity assertion run with `SHELL_GATE_STEPS`
emptied — each must make it throw. `gateInvocations` has its own control
asserting it really extracts the shapes both sides are written in, because a
comparator that silently returned nothing would make every command comparison
vacuous. Both mutation helpers fail loudly if their own edit matched nothing:
that already fired once on this branch when `biome check --write` sorted object
keys out from under a literal anchor.

The mapping is exhaustive in BOTH directions: a missing entry surfaces as an
unmapped step, and a STALE entry — one naming a step `test.yml` no longer has —
fails its own test, because otherwise it would quietly shrink what the contract
checks while every test stayed green.

The local CSS validation is `scripts/validate-css-bundle.mjs`, a small Node
script rather than the workflow's POSIX shell snippet, so it makes the same
byte/pattern assertions on Windows as on Unix; its paired controls prove both
failure modes still fail. CI's half of that step is still inline shell, which
is why it remains in `SHELL_GATE_STEPS` — that entry now means "CI's command is
unparseable by the comparator", not "nothing verifies this".

What this deliberately does NOT catch: a mapped CI command that gains or
changes a FLAG the local plan does not mirror (say `lint:ci --max-warnings=0`).
The token model compares which gates run, not their every argument. Snapshotting
each `run:` block verbatim into the test was tried and rejected — it is a
hand-maintained second copy of `test.yml`, the exact shape this section exists
to remove, and its failure mode invites a paste-and-move-on update rather than a
decision. The arguments that actually carry a contract are asserted
individually, read live from the workflow: the Unit lanes' `--concurrency=4`
and `--concurrency=2`, and Build's `--continue=dependencies-successful`.

Local-vs-CI difference that is stated rather than hidden: the boundary gate
(`pnpm run boundaries`) treats git-ignored files as generated rather than
source, and a developer's personal excludes (`~/.config/git/ignore`,
`.git/info/exclude`) count locally while CI's checkout has neither — so CI is
the stricter side. This used to read the other way round, that a stale local
`dist/` could produce a phantom violation the clean CI checkout never saw;
scoping the verdict to non-ignored files removed that difference, and with it
the `pnpm clean`-and-rerun ritual. See `package-boundary-gate.md`.
