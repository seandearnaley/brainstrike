# Ubicloud runners — evidence

Supports `docs/agents/ci-quality.md` § "Cost-ranked Linux x64 jobs run on
Ubicloud" (BST-765). Read this before proposing to move a job between runner
providers, add a provider fallback, gate Native Windows on changed paths, cache
a native build output, or lift the Static type-check concurrency cap. The
contract holds the rules; this file is the record of why.

`unit-shard`, `build`, `native-electron`, `browser-tests`, `web-e2e`,
`desktop-e2e-smoke`, and `desktop-e2e-delegated` in `test.yml` run on
`ubicloud-standard-4`. (Corrected: the original named a single `desktop-e2e`
job; that id is now the `ubuntu-slim` fan-in over the two Ubicloud jobs.) That runner preserves the
4-vCPU/16-GB class used for the x64 work while moving the measured, dominant
Linux x64 lanes to the connected Ubicloud runner fleet. React Doctor, Claude
Auto Review, and `@claude` handling use `ubicloud-standard-2`, preserving the
previous private `ubuntu-latest` 2-vCPU/8-GB shape at the lower managed-runner
rate. PR Coverage started there too and moved to `ubicloud-standard-4` (BST-1882,
see the dated note below). The boundary is deliberate:

- quiet-head admission remains on GitHub `ubuntu-slim`
- the lightweight Unit and Desktop E2E fan-ins also use GitHub `ubuntu-slim`
- Static remains on the measured GitHub ARM lane
- all nine physical Unit rows use one fixed Ubicloud runner class (two DB
  shards, two Agent shards, three desktop shards, and the heavy and rest rows)
- Native Windows remains on GitHub Windows for every admitted head
- scheduled regression/coverage jobs remain GitHub-hosted until their existing
  baselines are green enough to support a runner comparison
- main-failure/recovery and scheduled-failure notifiers remain GitHub-hosted

The Unit matrix moved as a whole after GitHub's ARM pool terminated the
`rest` shard without a failing test assertion on five consecutive attempts
across two exact PR heads (runs 30158896583 and 30175303301 on 2026-07-25).
Do not route individual shards to different providers: keeping one fixed
runner contract avoids a provider-selection layer while preserving the exact
partition, integration concurrency, and required `Unit` fan-in.

The nine physical rows form five logical package partitions: `db`, `agent`,
`desktop`, `heavy` (UI packages), and `rest`. DB uses `DB_TEST_SHARD=1/2`
and `2/2`; Agent uses `AGENT_TEST_SHARD=1/2` and `2/2`; desktop uses
`DESKTOP_TEST_SHARD=1/3`, `2/3`, and `3/3` for both unit and integration.
Each variable is scoped to its owning package's Turbo tasks, and each native
shard runs files from one package only. Turbo CLI
passthrough is forbidden because it also reaches dependency/transit tasks.
`scripts/unit-shard-partition.mjs` rejects missing, duplicate, mixed-count,
or divergent-filter rows. Agent and Desktop configs reject a missing required
shard; each environment participates in its package task's cache key, so one
shard cannot replay an unsharded or different-shard result.

Do not add a provider-selection layer or an automatic GitHub fallback. An
Ubicloud provisioning failure must queue or fail visibly; rollback is an
explicit revert of the runner-label change. Existing cache and setup actions
stay unchanged because Ubicloud's transparent cache supports the standard
GitHub cache actions. The cost audit and service evidence live in
`docs/superpowers/research/2026-08-28-ubicloud-github-actions-runners.md`.
Contract coverage lives in
`scripts/__tests__/ubicloud-runner-contract.test.mjs`.

The Static job caps the monorepo type-check with Turbo's official
`TURBO_CONCURRENCY=4` environment variable.
Unbounded scheduling repeatedly exhausted the arm64 runner after the workspace
reached 43 packages: Turbo received a shutdown signal while launching more than
30 type-check tasks and the shell exited 137 without a TypeScript diagnostic.
Keep the cap on the CI invocation rather than weakening package coverage or
changing local developer defaults. The exact workflow command is guarded by
`scripts/__tests__/quiet-head-admission-contract.test.mjs`.

**Non-obvious trap for future maintainers:** the turbo *remote* cache
(`TURBO_TOKEN`/`TURBO_TEAM`) is arch-agnostic — turbo's cache hash does not
include CPU architecture, and `runner.os` reports `"Linux"` on both x64 and
arm64 GitHub-hosted runners. So an arm64 lane will mostly **replay**
x64-produced remote-cache entries rather than independently validate on
arm64 (benign for this repo's JS/dts/log outputs, which are
arch-independent, but worth knowing before treating a green arm64 run as
proof of arch-independent correctness for something that isn't). Whichever
arch runs first populates the shared remote cache for both. The *local*
`.turbo` `actions/cache` layer (`setup-workspace/action.yml`) is correctly
arch-namespaced (`${{ runner.os }}-${{ runner.arch }}-turbo-...`, added in
C2/#1668) so it cannot cross-restore an incompatible entry — that guard
just doesn't extend to the remote cache.

**Native (node-gyp) build outputs are the exception to "arch-independent"
and MUST NOT be turbo-cached.** `@brainstrike/secure-fs-native` compiles an
arch/ABI-specific `.node` into `build/**`. When its turbo `build` task cached
that output, the arch-blind remote cache let the arm64 Static/Unit jobs
populate an entry that the x64 Coverage job (`ubicloud-standard-2`) then replayed —
so `apps/desktop`'s coverage lane, which loads the real addon via its
`*.integration.test.*` files, died with `secure_fs_native.node: cannot open
shared object file` on every PR touching `apps/desktop` (PR #1749 shipped a
runner-side rebuild; the follow-up made the fix structural). Its `build` task
is now `cache: false` (`packages/secure-fs-native/turbo.json`), matching the
same package's long-standing `test` policy, so every runner node-gyp-rebuilds
the addon for its own ABI. Any future native/node-gyp package added to the
monorepo must do the same — never cache a compiled binary on turbo's
source-only, arch-blind hash.

**Native Windows stays always-on after quiet-head admission (R10).** The
non-required job consumed 2,440 rounded Windows minutes ($24.40 list price) in
the 2026-08-21..28 audit, but GitHub Actions has no native job-level changed-path
filter. Do not add a repository diff classifier, planner, or routing registry to
avoid that allocation: the root workflow contract explicitly prohibits custom
CI routing machinery. `native-windows` therefore depends directly on
`admission` and runs for every admitted PR, push to `main`, and manual dispatch.
`scripts/__tests__/ubicloud-runner-contract.test.mjs` guards both the always-on
dependency and the absence of a `native-windows-impact` planner.

## PR Coverage moved to `ubicloud-standard-4` (BST-1882, 2026-09-29)

Every PR `Coverage` run from 2026-09-29 05:24 UTC failed: 12 consecutive runs on
unrelated branches, after weeks of passing. The job died inside `Setup workspace`
with the step still `in_progress` and no runner name. The check-run annotation
was `System.IO.IOException: No space left on device` writing the runner's own
`_diag/Worker_*.log`.

Ruled out: the `.turbo` cache (at most 305 MB), the pnpm store cache (671 MB) and
git history (95 MB packed) were all unchanged in size. React Doctor runs on the
same label with `fetch-depth: 0` and kept passing, but it never runs
`pnpm install`. Coverage was the only `ubicloud-standard-2` workflow doing the
full install + turbo build + coverage run, and every `test.yml` lane doing that
work runs on `ubicloud-standard-4` and kept passing.

Ubicloud's runner-types documentation lists `ubicloud-standard-2` at 75 GB of
disk and `ubicloud-standard-4` at 150 GB. The workload is a few GB, so the free
space left on the 2-vCPU image dropped below what a full install needs. That
this was an image change is an inference from the branch-independent onset.

Coverage now uses the same runner class as the install + build lanes. It runs
once per PR lifecycle, never on `synchronize`, so the cost delta is small.
Freeing space by deleting preinstalled toolchains was rejected: it depends on
the image's contents and silently breaks when they move.
