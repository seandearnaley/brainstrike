# Dependency Upgrade Workflow (Full-Repo Sweep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement Phases 1-3 task-by-task. Phase 4+ tracks are executed via the `Workflow` tool per the script in [Phase 4 orchestration script](#phase-4-orchestration-script) — do not hand-execute them serially. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every direct dependency in the `brainstrike` pnpm workspace to (or deliberately toward) latest, with red/green test evidence for every change, grounded research for every breaking change, and a PR/CI shape that keeps GitHub Actions minutes low.

**Architecture:** Three cheap, mechanical, low-risk batch PRs land first and re-baseline the lockfile (merged serially, fast). Once main has a fresh lockfile, ~13 independent research-requiring tracks (majors, pre-1.0 minors, and two previously-blocked upgrades) run **in parallel**, each in its own isolated git worktree, via the `Workflow` tool's `pipeline()` primitive (research → implement → verify stages overlap across tracks — track A's implementation runs while track B is still researching). Every track validates locally with the repo's own `pnpm check` before ever pushing, so GitHub Actions CI is confirmatory, not exploratory — this is the single biggest CI-cost lever available (see [CI cost strategy](#ci-cost-strategy)).

**Tech Stack:** pnpm workspaces + Turborepo, Vitest/Playwright, `syncpack` (version consistency), `knip` (dead code), the existing `scripts/generate-dependency-update-report.mjs` audit tool, git worktrees for agent isolation, the Claude Code `Workflow` tool for the parallel research/implement/verify pipeline.

---

## Grounded audit (2026-07-06, this session — supersedes the 2026-06-10 report until regenerated)

Ran `pnpm outdated -r --format json` and `pnpm outdated -r --no-table` fresh in this worktree (no `node_modules` installed, so `current` reads as `missing`; `wanted` — the version already permitted by each package.json's existing semver range — is used as the effective baseline instead). 193 total outdated entries, 26 of which are `@brainstrike/*` workspace `link:` self-references (false positives from the missing-install artifact, not real packages).

| Tier | Count | Meaning | Package.json edit needed? |
| --- | ---: | --- | --- |
| **In-range** | 63 | `wanted === latest`; the existing `^`/`~` range already permits it | No — `pnpm update -r` (no `--latest`) picks these up, zero code risk |
| **Patch** | 35 | Same major.minor, patch differs | Yes, but same range family — trivial |
| **Minor (1.x+)** | 39 | Same major, minor differs, package is already ≥1.0 | Yes — usually additive, per semver contract |
| **Minor (0.x pre-1.0)** | 6 | Package is pre-1.0; semver gives no backward-compat guarantee on minor bumps | Yes — **treat as risky regardless of the small-looking diff** |
| **True major** | 21 | First version segment differs | Yes — **assume breaking until research says otherwise** |

**Existing prior art found and reused, not duplicated:** [`docs/dependency-version-updates-report.md`](../../dependency-version-updates-report.md) and [`docs/dependency-updates-breaking-changes.md`](../../dependency-updates-breaking-changes.md) (generated 2026-06-10, regenerable via `node scripts/generate-dependency-update-report.mjs`) already carry researched breaking-change notes for most of this list, plus a **"Deferred or pinned dependencies"** table recording two upgrades that were attempted before and deliberately held back with a concrete root cause:

- `typescript` pinned at `^5.9.3` — TS 6.0's stricter DOM types break `FileSystemDirectoryHandle` test mocks in `packages/utils`.
- `react-helmet-async` pinned at `^2.0.5` — 3.x's `exports` field breaks Vite's resolution of `react-fast-compare` under `preserveSymlinks: true`.

Also found `git log` evidence of a **prior full sweep**, PR #883 ("deps: workspace-wide dependency update sweep (waves 1-4)"), which used a wave structure (patch → tooling minors → framework minors → majors) inside **one PR** with local `pnpm check --fast --no-e2e --no-install` validation before each push. This plan reuses that validated wave shape for the batch PRs (Phases 1-3) but splits majors into **separate, parallel-worked PRs** instead of wave-4-style serial commits, because the user asked for team-of-agents parallelism this time.

**What has changed since the 2026-06-10 report** (must be freshly researched — not covered by the existing breaking-changes doc):

- `@babel/core` / `@babel/parser` / `@babel/plugin-transform-runtime` / `@babel/runtime`: was patch-only (7.29.0→7.29.7) in June; **Babel 8 has since shipped** (7.29.x→8.0.x). This is now a true major and needs first-party research, including whether `babel-plugin-react-compiler@1.0.0` (root devDependency) supports Babel 8 yet.
- `@ai-sdk/anthropic` / `@ai-sdk/google` / `@ai-sdk/openai` / `@ai-sdk/provider`: was patch-only in June (e.g. 3.0.66→3.0.68); now a true major (3.x→4.x). Needs fresh research — this is the exact provider-factory seam documented in `AI ASSISTANT INTEGRATION` / `LOCAL LLM ARCHITECTURE` in `AGENTS.md`.
- `@types/node`: was minor in June (25.6.0→25.9.2); now a true major (25.6.0→26.1.0). Needs a check against the declared Node 24.x `engines` range — `@types/node@26` may describe Node 26 APIs not present in the Node 24 runtime this repo targets.
- `strip-ansi` (direct dep in `apps/desktop/package.json`): not in the June report at all; now shows a major (6.0.1→7.2.0). `strip-ansi@7` is ESM-only — verify the importing file's module format before bumping.
- Electron has moved past what the breaking-changes doc covers: doc covers 41→42; registry now shows 41→**43** (an extra major crossed). Both 42 and 43 breaking-change catalogs need review, not just 43.
- The Docusaurus app was removed (`f079e89ee`, "chore: remove Docusaurus docs app (#1236)") since the June report — the webpack-5.106/BST-511 pin the breaking-changes doc's older revision tracked is now moot (verified: no `webpack` entry remains in `pnpm-workspace.yaml` overrides or root `package.json`). Docusaurus-only rows in old reports (docusaurus, mdx, mermaid layout-elk) no longer apply.

---

## PR / branch strategy

```
main
 └─ chore/deps-batch-1-inrange        (Phase 1, merges first)
     └─ chore/deps-batch-2-patch      (Phase 2, rebases onto batch-1 after merge)
         └─ chore/deps-batch-3-minor  (Phase 3, rebases onto batch-2 after merge)
             ├─ chore/deps-typescript-6        (Phase 4, independent worktree, branches off updated main)
             ├─ chore/deps-electron-43         (Phase 4, independent worktree)
             ├─ chore/deps-assistant-ui        (Phase 4, independent worktree)
             ├─ chore/deps-ai-sdk-4            (Phase 4, independent worktree)
             ├─ chore/deps-mastra              (Phase 4, independent worktree)
             ├─ chore/deps-babel-8             (Phase 4, independent worktree)
             ├─ chore/deps-knip-6              (Phase 4, independent worktree)
             ├─ chore/deps-react-doctor        (Phase 4, independent worktree)
             ├─ chore/deps-react-helmet-async-3 (Phase 4, independent worktree)
             ├─ chore/deps-vercel-cli          (Phase 4, independent worktree)
             ├─ chore/deps-commitlint          (Phase 4, independent worktree)
             ├─ chore/deps-misc-majors         (Phase 4: concurrently, syncpack, @codecov/vite-plugin, strip-ansi)
             └─ chore/deps-pre1.0-minors       (Phase 4: oxc-parser, react-shiki, web-tree-sitter)
```

**Why batches are stacked but majors are independent-off-main:** Phases 1-3 each touch `pnpm-lock.yaml` broadly (every entry gets re-resolved), so running them concurrently would produce guaranteed lockfile conflicts for near-zero benefit (they're mechanical, not research-bound — parallelism buys nothing here). Majors touch **narrow, scoped** regions of the lockfile and are research-bound, so parallelism buys real wall-clock time; branching each off the post-batch-3 `main` (not off each other) means no agent waits on another agent's PR to merge before starting, and lockfile conflicts between two majors are rare (different package names, non-overlapping lockfile sections) — the rare case where they DO conflict is easy to rebase-resolve at merge time since it's a generated file.

**Two tracks need special sequencing, not blind parallelism** (fragility/coupling — AGENTS.md systemic checklist):

1. `@ai-sdk/*` (4.x), `@mastra/*` (1.49.x), and `@assistant-ui/react*` (0.14.x) all feed the same runtime seam in `packages/agent` (provider-factory → Mastra agent loop → DataStreamMapper → assistant-ui panel) documented across `ASSISTANT RESILIENCE`, `PERMISSION ENGINE`, and `ASSISTANT THREAD PERSISTENCE` in `AGENTS.md`, each with a "LIVE" real-agent-loop proof test that must keep passing. They can still be *implemented* in parallel (different files, different worktrees), but land in this order — Mastra first (smallest, same-major minor bump), then AI SDK (major, isolated to `packages/agent/src/providers`), then assistant-ui (major, largest blast radius, touches `packages/ui` too) — and **Phase 5 adds one integration-verification task after all three merge**, running the full Mastra live-loop suite (`mastra-tool-execution.spec.ts`, `mastra-tool-approval-suspend.spec.ts`, `mastra-memory-persistence.spec.ts`, `mastra-local-host-execution.spec.ts`) together against the combined result, because each track's own worktree only proves its own change in isolation, not the three-way combination.
2. TypeScript 6 is a repo-wide compiler change. Land it **last**, after every other Phase 4 track has merged, so its own PR only has to answer "does TS6 break anything" against an otherwise-fully-upgraded baseline, instead of every other track also having to re-validate against a new compiler mid-flight.

---

## CI cost strategy

This repo's PR CI (`AGENTS.md` → `PR CI FLOW`) already runs Static + Unit (affected-scoped) + build + Web/Desktop E2E **smoke** on every PR; full E2E regression is schedule/dispatch-only. Given 13+ parallel PRs, the cost lever is **not** which CI jobs run — it's how many times CI has to run per PR before it goes green:

1. **Every agent runs the repo's own gate locally before pushing anything.** `pnpm check --fast --no-e2e --no-install` (lint + build + type-check + `test:fast` + `test:browser`) mirrors what CI checks. This is the exact validation line PR #883 used per-wave. An agent that pushes with this red has skipped a required step.
2. **One push per PR, not iterative push-fix-push.** Fix locally, re-run `pnpm check --fast`, then push once CI-equivalent is green. CI is the second opinion, not the first (per `AGENTS.md`: "CI is there to double-check, not to tell you what you broke").
3. **Batch what's mechanical, isolate what's risky** — a single 63-package "already in range" PR is one CI run for 63 packages, versus 63 CI runs if split. Only split out what genuinely needs independent research/review/merge timing.
4. **Full E2E regression is opt-in, not default.** For Electron (two majors crossed) and TypeScript 6 (repo-wide), explicitly trigger `gh workflow run desktop-e2e.yml` / `web-e2e.yml` (or `workflow_dispatch` equivalents) as a deliberate extra step for those two tracks only, rather than relying on PR smoke alone — but this is a real GitHub Actions spend, so confirm with the user before dispatching (see [Open decisions](#open-decisions-before-executing)).
5. **`isolation: 'worktree'` is used only for the parallel Phase 4 agents** that mutate files concurrently — not for Phases 1-3, which run sequentially in one place (worktree isolation has real setup cost per the `Agent`/`Workflow` tool docs; don't pay it where nothing runs concurrently).

---

## Phase 1: In-range lockfile refresh (zero code risk)

**Files:**
- Modify: `pnpm-lock.yaml` (regenerated only — no `package.json` edits)

- [ ] **Step 1: Capture the red/green baseline before touching anything**

```bash
pnpm install --frozen-lockfile
pnpm check --fast --no-e2e --no-install 2>&1 | tee /tmp/deps-batch1-baseline.log
```
Expected: green (this is the "red" in the TDD sense only insofar as it establishes the pre-change pass count to diff against — there is no code change in this phase, so there's nothing to make "fail first").

- [ ] **Step 2: Refresh in-range packages**

```bash
git checkout -b chore/deps-batch-1-inrange
pnpm update -r
```
This only touches packages where `wanted === latest` (the 63-package tier) — pnpm's semver range resolution guarantees it cannot silently cross a major or an unsatisfied minor, so no `package.json` diff is expected, only `pnpm-lock.yaml`.

- [ ] **Step 3: Verify nothing regressed**

```bash
pnpm check --fast --no-e2e --no-install 2>&1 | tee /tmp/deps-batch1-after.log
diff <(grep -oE '[0-9]+ (passed|failed)' /tmp/deps-batch1-baseline.log) <(grep -oE '[0-9]+ (passed|failed)' /tmp/deps-batch1-after.log)
```
Expected: identical pass/fail counts (no diff output). If the diff shows a new `failed` line, stop and investigate via `superpowers:systematic-debugging` before proceeding — an in-range bump regressing tests means a dependency shipped a behavior change inside what should be a safe range, which is itself worth a standalone bug report upstream.

- [ ] **Step 4: Regenerate the audit docs and commit**

```bash
node scripts/generate-dependency-update-report.mjs
git add pnpm-lock.yaml docs/dependency-version-updates-report.md
git commit -m "deps(batch 1): refresh in-range packages to latest (no package.json changes)"
```

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin chore/deps-batch-1-inrange
gh pr create --title "deps(batch 1): in-range lockfile refresh" --body "63 packages where the existing semver range already permits latest. No package.json edits. pnpm check --fast green before/after with identical pass counts."
```

---

## Phase 2: Patch bumps (35 packages)

**Files:**
- Modify: `pnpm-lock.yaml` and the `package.json` of every workspace that declares one of the 35 patch-tier packages (see the full list in the [grounded audit](#grounded-audit-2026-07-06-this-session--supersedes-the-2026-06-10-report-until-regenerated) output, re-run to get exact current numbers before starting this phase — versions will have moved again by execution time)

- [ ] **Step 1: Branch from the merged batch-1**

```bash
git checkout main && git pull
git checkout -b chore/deps-batch-2-patch
```

- [ ] **Step 2: Bump patch-tier packages workspace-wide**

```bash
pnpm outdated -r --no-table > /tmp/deps-current.txt   # re-check; versions drift daily
pnpm update -r --latest --filter '@codemirror/language' --filter '@codemirror/view' --filter '@electric-sql/pglite' --filter '@electric-sql/pglite-pgvector' --filter '@fontsource-variable/geist' --filter '@fontsource-variable/geist-mono' --filter '@radix-ui/react-accordion' --filter '@radix-ui/react-checkbox' --filter '@radix-ui/react-dialog' --filter '@radix-ui/react-dropdown-menu' --filter '@radix-ui/react-label' --filter '@radix-ui/react-popover' --filter '@radix-ui/react-progress' --filter '@radix-ui/react-scroll-area' --filter '@radix-ui/react-tabs' --filter '@radix-ui/react-toast' --filter '@radix-ui/react-tooltip' --filter '@swc/core' --filter '@types/react' --filter '@vitejs/plugin-react' --filter '@vitest/browser-playwright' --filter '@vitest/coverage-v8' --filter '@vitest/ui' --filter 'assistant-stream' --filter 'dompurify' --filter 'esbuild' --filter 'lefthook' --filter 'react' --filter 'react-dom' --filter 'vite-plugin-static-copy' --filter 'vitest' --filter 'wait-on' --filter 'workerpool' --filter 'zustand'
```
`--latest` is required here specifically because `wanted !== latest` for this tier (patch differs) — plain `pnpm update -r` would leave these alone.

**`@electric-sql/pglite` / `@electric-sql/pglite-pgvector` get one extra check** (per `PGLITE EXTENSION INVARIANT` in `AGENTS.md` — this project has been burned by pglite upgrades before, per memory of the 0.4→0.5/PG18 stack): after bumping, run the extension-loading integration tests specifically, not just the general suite:
```bash
pnpm --filter @brainstrike/db test -- drizzle-migrate
pnpm --filter @brainstrike/db test -- drizzle-job-queue-compatibility
```

- [ ] **Step 3: Apply lint auto-fixes if the new tool versions add rules**

```bash
pnpm dlx ultracite fix
```
(Precedent from PR #883 wave 1: a Biome patch bump added rules like `noSubstr` / `noArrayIndexKey` that needed codemod fixups. Expect similar small mechanical fixes, not logic changes.)

- [ ] **Step 4: Full local gate, then commit**

```bash
pnpm check --fast --no-e2e --no-install
git add -A
git commit -m "deps(batch 2): patch-level bumps across workspace + lint auto-fixes"
```

- [ ] **Step 5: Push and open PR (stacked on batch-1)**

```bash
git push -u origin chore/deps-batch-2-patch
gh pr create --base chore/deps-batch-1-inrange --title "deps(batch 2): patch-level bumps" --body "35 packages, patch-only. pnpm check --fast green. Rebase onto main once batch-1 merges."
```

---

## Phase 3: Minor bumps, 1.x+ packages (39 packages, minus the Mastra trio)

**Files:** same shape as Phase 2 — `package.json` per affected workspace + `pnpm-lock.yaml`.

Exclude `@mastra/core`, `@mastra/mcp`, `@mastra/memory` from this batch — they're technically 1.x+ minors (safe by the tier definition), but per the [sequencing note](#pr--branch-strategy) they're pulled into Phase 4 alongside `@ai-sdk/*` and `@assistant-ui/*` so the three-way integration check in Phase 5 has all three in one place.

- [ ] **Step 1: Branch from the merged batch-2**

```bash
git checkout main && git pull
git checkout -b chore/deps-batch-3-minor
```

- [ ] **Step 2: Bump the remaining 1.x+ minor-tier packages**

```bash
pnpm update -r --latest --filter '@biomejs/biome' --filter '@codemirror/state' --filter '@huggingface/transformers' --filter '@mermaid-js/mermaid-cli' --filter '@modelcontextprotocol/server-filesystem' --filter '@playwright/test' --filter '@radix-ui/react-context-menu' --filter '@radix-ui/react-select' --filter '@radix-ui/react-slot' --filter '@radix-ui/react-switch' --filter '@shikijs/langs' --filter '@shikijs/themes' --filter '@tailwindcss/vite' --filter '@tanstack/react-virtual' --filter '@typescript-eslint/parser' --filter 'electron-builder' --filter 'electron-builder-squirrel-windows' --filter 'eslint' --filter 'happy-dom' --filter 'jsdom' --filter 'lucide-react' --filter 'mermaid' --filter 'motion' --filter 'playwright' --filter 'react-hotkeys-hook' --filter 'react-resizable-panels' --filter 'react-router-dom' --filter 'shiki' --filter 'tailwind-merge' --filter 'tailwindcss' --filter 'terser' --filter 'tsx' --filter 'turbo' --filter 'ultracite' --filter 'vite' --filter 'zod'
```

- [ ] **Step 3: Package-specific verification for the higher-blast-radius ones in this batch**
  - `lucide-react` (1.8→1.23, several minors of icon churn): `grep -rn "from 'lucide-react'" apps packages --include='*.tsx' -l | xargs -I{} pnpm exec tsc --noEmit {}` isn't meaningful standalone — instead just make sure the full type-check (Step 4) is clean, since a renamed/removed icon shows up as a TS2305 import error, not a silent runtime issue.
  - `tailwindcss` + `@tailwindcss/vite` (paired, must move together — already true here): re-run any visual/snapshot tests for `apps/web` and `apps/desktop`.
  - `@playwright/test` + `playwright` (paired, must move together — already true here): `pnpm exec playwright install chromium` before running e2e-tagged suites, since minor Playwright bumps sometimes pin a new browser revision (precedent: PR #883 wave 1 hit exactly this).
  - `turbo`: check `turbo.jsonc` for any new "future flags" mentioned in the 2.10 changelog before assuming defaults are unchanged.

- [ ] **Step 4: Full local gate, lint fixups, commit**

```bash
pnpm dlx ultracite fix
pnpm check --fast --no-e2e --no-install
git add -A
git commit -m "deps(batch 3): minor bumps across 1.x+ workspace packages"
```

- [ ] **Step 5: Push and open PR (stacked on batch-2)**

```bash
git push -u origin chore/deps-batch-3-minor
gh pr create --base chore/deps-batch-2-patch --title "deps(batch 3): minor bumps (1.x+ packages)" --body "39 packages, minor-level, already ≥1.0. pnpm check --fast green. Playwright browsers reinstalled. Rebase onto main once batch-2 merges."
```

---

## Phase 4: Parallel research-bound tracks (majors, pre-1.0 minors, previously-blocked upgrades)

Each track below is **not** hand-writable as exact code right now — the whole point of this phase is that the breaking-change specifics aren't known until an agent actually reads the changelog (writing fictional migration code ahead of that research would violate "verify, don't assume"). Instead, every track follows the same fixed **task template**, and the `Workflow` script in the next section instantiates one per track, run in parallel via `pipeline()`.

### Task template (every Phase 4 track follows this exactly)

1. **Research** (no file edits yet): fetch the target package's changelog/release notes for every major version crossed (not just current→latest — e.g. Electron must cover both the 42 and 43 catalogs). Prefer the existing entry in `docs/dependency-updates-breaking-changes.md` as a starting point where one exists, but treat it as **stale by ~4 weeks** and verify against the live changelog before trusting version-specific claims in it. Output: a short structured note (what breaks, what doesn't, any repo-specific risk given the `AGENTS.md` architecture sections that name this package).
2. **Isolated worktree**: create a git worktree (`superpowers:using-git-worktrees` or `Agent` tool `isolation: 'worktree'`) branched from the post-batch-3 `main`.
3. **Red**: run the narrowest test/build/type-check command that exercises this package's integration points (not the whole suite yet — this phase runs in parallel across ~13 tracks, so keep each track's inner loop fast) — for example, `packages/agent`'s own `pnpm --filter @brainstrike/agent test` for the Mastra/AI SDK/assistant-ui tracks, `pnpm --filter @brainstrike/desktop type-check` for Electron. Confirm the CURRENT (pre-bump) state passes — this is the baseline, not literally a failing test, since there's no new behavior being added, only a dependency swap.
4. **Bump + fix**: apply the version bump, then make the minimum code change required by the research findings (e.g., a removed API, a changed default, a new required option).
5. **Green**: re-run the same narrow command from step 3; it must pass. Then run the full `pnpm check --fast --no-e2e --no-install` gate once, to catch any repo-wide fallout the narrow command didn't cover.
6. **Adversarial review pass**: a second agent (not the implementer) reviews the diff against the research note from step 1 — does the code change actually address every documented breaking change, or only the one that happened to surface as a test failure? (Silent behavior changes that don't fail a test are the ones worth an adversarial second look.)
7. **Commit, push, open PR** off the shared `main` baseline, following the commit-message precedent from PR #883 (name the exact old→new versions, list the specific breaking change addressed, state the validation command that went green).

### Track roster and researcher's starting context

| Track | Packages | Starting context for the research step |
| --- | --- | --- |
| `typescript-6` | `typescript` | **Land last** (see sequencing note). Known blocker from the existing doc: TS 6's stricter DOM types break `FileSystemDirectoryHandle` mocks in `packages/utils` tests — find and fix those mocks *before* flipping the version, so the bump itself lands green on the first try instead of red-then-fixed. |
| `electron-43` | `electron` | Two majors crossed (41→42→43) — read both catalogs at https://www.electronjs.org/docs/latest/breaking-changes. Existing doc flags PDF guest-WebContents, `session.cookies` `cause` values, and `WebContentsView` teardown timing for 42; 43 needs fresh research. Cross-check against every documented Electron seam in `AGENTS.md` (`EMBEDDING ARCHITECTURE`, `LOCAL LLM ARCHITECTURE` hidden-host windows). Recommend running desktop's full E2E (not just PR smoke) before merge — flag this to the user, don't auto-dispatch. |
| `assistant-ui` | `@assistant-ui/react`, `@assistant-ui/react-markdown`, `@assistant-ui/react-data-stream`, `@assistant-ui/styles` (deprecated — find its replacement) | **Use the existing `update` skill** (`Update assistant-ui and AI SDK to latest versions. Detects current versions, identifies breaking changes, and executes migrations.`) as the researcher/implementer for this track instead of ad hoc research — it's purpose-built for exactly this upgrade. Land after Mastra, before the Phase 5 integration check. This is the highest blast-radius track in the whole plan (`ASSISTANT RESILIENCE`, `PERMISSION ENGINE`, `ASSISTANT THREAD PERSISTENCE` in `AGENTS.md` all wrap this package). |
| `ai-sdk-4` | `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/provider` | Also candidate for the `update` skill (it covers "AI SDK" explicitly). Net-new major since the June report — no existing research to lean on. Check `packages/agent/src/providers/provider-factory.ts` and `registry.ts` for direct provider-API usage that a 3→4 major might rename. |
| `mastra` | `@mastra/core`, `@mastra/mcp`, `@mastra/memory` | Same-major minor (1.37→1.49 core is a big minor jump — 12 releases). Land first among the three coupled tracks. Re-run `mastra-tool-execution.spec.ts` and `mastra-tool-approval-suspend.spec.ts` specifically — these are the documented LIVE proof tests that previously caught a real regression from a Mastra bump (see `ASSISTANT RESILIENCE` in `AGENTS.md`). |
| `babel-8` | `@babel/core`, `@babel/parser`, `@babel/plugin-transform-runtime`, `@babel/runtime` | Net-new major (Babel 8 shipped since June). First check: does `babel-plugin-react-compiler@1.0.0` (root devDependency, not itself outdated per this audit) declare Babel 8 support? If not, this is a **candidate for the "deferred/pinned" table**, not a forced bump — don't break the React Compiler integration to chase a devDependency major. |
| `knip-6` | `knip` | Existing doc already flags: Node baseline requirement (confirm ≥ repo's declared v20.19+ floor — repo runs Node 24.x, should be fine, verify anyway), removed/renamed CLI flags, JSON reporter shape change (arrays instead of `issues._files`). **Must re-verify against `doctor.config.ts` and `knip.jsonc`** — `AGENTS.md`'s `REACT DOCTOR` section documents that `deslop` reads knip's config directly; confirm the config schema knip 6 expects still matches. |
| `react-doctor` | `react-doctor` (0.5.5→0.7.1) | `AGENTS.md`'s `REACT DOCTOR` section explicitly states its invariants were **"verified against 0.5.5"** (the `ignore.files` behavior, the disabled rule list, the `deslop`-vs-knip config split). Every one of those invariants must be re-verified against 0.7.1's actual behavior, not just "tests still pass" — update the `AGENTS.md` section if anything changed. |
| `react-helmet-async-3` | `react-helmet-async` | Known blocker from the existing doc: 3.x's `exports` field breaks Vite's resolution of `react-fast-compare` under `preserveSymlinks: true`. Check whether Vite 8.0.8 (already newer than whenever this was last tested) resolves it differently now — this may already be fixed by the Vite bumps in batches 1-3, in which case this track is just a verification, not a workaround. |
| `vercel-cli` | `vercel` | Existing doc flags every scripted `vercel` invocation (deploy/env/pull/link/blob) needing a recheck across this multi-major jump (50→54). The session's own SessionStart hook already independently flagged this exact CLI as outdated — corroborating signal. |
| `commitlint` | `@commitlint/cli`, `@commitlint/config-conventional`, `@commitlint/types` | Existing doc: run the commitlint config against representative valid/invalid commit messages before bumping; check `@commitlint/types` consumers compile. |
| `misc-majors` | `concurrently`, `syncpack`, `@codecov/vite-plugin`, `strip-ansi`, `@types/node` | Grouped because each is small/independent. `strip-ansi@7` is ESM-only — check `apps/desktop`'s usage site imports it in a context that supports ESM before bumping (CJS `require('strip-ansi')` will break). `@types/node@26` — confirm it doesn't describe Node 26-only globals the Node 24.x runtime lacks; if it does, hold this one back like TS6/react-helmet-async and document it. |
| `pre1.0-minors` | `oxc-parser`, `react-shiki`, `web-tree-sitter` | Pre-1.0 minors — small version deltas but no semver backward-compat guarantee. Treat each bump as if it were a major: read the changelog, don't just bump-and-hope. |

---

## Phase 5: Cross-track integration verification (barrier — runs only after Mastra + AI SDK + assistant-ui all merge)

**Files:** none new — this is a verification-only task, no independent PR.

- [ ] **Step 1: Sync a scratch branch with all three merged**

```bash
git checkout main && git pull   # after mastra, ai-sdk-4, and assistant-ui tracks have all merged
```

- [ ] **Step 2: Run the full Mastra live-loop proof suite together**

```bash
pnpm --filter @brainstrike/agent test -- mastra-tool-execution
pnpm --filter @brainstrike/agent test -- mastra-tool-approval-suspend
pnpm --filter @brainstrike/agent test -- mastra-memory-persistence
pnpm --filter @brainstrike/agent test -- mastra-local-host-execution
```
Expected: all green. These are real-agent-loop, no-mock proofs (per `AGENTS.md`) specifically because a prior Mastra-adjacent change broke tool calling while every mocked test stayed green — this is the one place in the whole plan where "each PR's own tests passed" is not sufficient evidence.

- [ ] **Step 3: If anything fails here that didn't fail in any individual track's PR**, that's a genuine interaction bug between two of the three upgrades — use `superpowers:systematic-debugging`, not a quick patch, since the individual tracks already proved themselves correct in isolation.

---

## Phase 4 orchestration script

This is the `Workflow` tool script that executes the Phase 4 track roster with real parallelism — research for track B starts while track A is already implementing, because `pipeline()` has no barrier between stages (see the tool's own docs: "wall-clock = slowest single-item chain, not sum-of-slowest-per-stage"). Two of the tracks (`assistant-ui`, `ai-sdk-4`) route through the dedicated `update` skill instead of generic research, per the roster table above.

```js
export const meta = {
  name: 'dependency-major-upgrades',
  description: 'Research, implement (isolated worktree), and adversarially review each high-risk dependency upgrade track in parallel',
  phases: [
    { title: 'Research', detail: 'grounded changelog research per track, reusing docs/dependency-updates-breaking-changes.md as a stale-but-useful starting point' },
    { title: 'Implement', detail: 'apply the bump + minimum fix in an isolated worktree, red baseline -> green after' },
    { title: 'Verify', detail: 'adversarial second-agent review against the research note, then open the PR' },
  ],
}

const TRACKS = [
  { key: 'mastra', packages: ['@mastra/core', '@mastra/mcp', '@mastra/memory'], useUpdateSkill: false },
  { key: 'ai-sdk-4', packages: ['@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/openai', '@ai-sdk/provider'], useUpdateSkill: true },
  { key: 'assistant-ui', packages: ['@assistant-ui/react', '@assistant-ui/react-markdown', '@assistant-ui/react-data-stream', '@assistant-ui/styles'], useUpdateSkill: true },
  { key: 'electron-43', packages: ['electron'], useUpdateSkill: false },
  { key: 'babel-8', packages: ['@babel/core', '@babel/parser', '@babel/plugin-transform-runtime', '@babel/runtime'], useUpdateSkill: false },
  { key: 'knip-6', packages: ['knip'], useUpdateSkill: false },
  { key: 'react-doctor', packages: ['react-doctor'], useUpdateSkill: false },
  { key: 'react-helmet-async-3', packages: ['react-helmet-async'], useUpdateSkill: false },
  { key: 'vercel-cli', packages: ['vercel'], useUpdateSkill: false },
  { key: 'commitlint', packages: ['@commitlint/cli', '@commitlint/config-conventional', '@commitlint/types'], useUpdateSkill: false },
  { key: 'misc-majors', packages: ['concurrently', 'syncpack', '@codecov/vite-plugin', 'strip-ansi', '@types/node'], useUpdateSkill: false },
  { key: 'pre1.0-minors', packages: ['oxc-parser', 'react-shiki', 'web-tree-sitter'], useUpdateSkill: false },
]

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['summary', 'breakingChanges', 'blockedReason'],
  properties: {
    summary: { type: 'string' },
    breakingChanges: { type: 'array', items: { type: 'string' } },
    blockedReason: { type: ['string', 'null'] },
  },
}
const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['branch', 'worktreePath', 'testsRun', 'allGreen', 'filesChanged'],
  properties: {
    branch: { type: 'string' },
    worktreePath: { type: 'string' },
    testsRun: { type: 'array', items: { type: 'string' } },
    allGreen: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['approved', 'issues', 'prUrl'],
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    prUrl: { type: ['string', 'null'] },
  },
}

function researchPrompt(track) {
  return `Research breaking changes for upgrading ${track.packages.join(', ')} to latest in the brainstrike monorepo. ` +
    `Start from docs/dependency-updates-breaking-changes.md if it covers this package, but treat it as ~4 weeks stale -- verify current claims against the live changelog/release notes for EVERY major version crossed since the doc's version, not just current-to-latest. ` +
    `Report: a summary, a list of concrete breaking changes relevant to THIS repo's usage (grep the repo for the package's API surface first), and blockedReason (null unless you find a hard blocker like the two already-documented pins for typescript/react-helmet-async, in which case explain it the same way).`
}
function implementPrompt(track, research) {
  const base = `Track: ${track.key}. Packages: ${track.packages.join(', ')}. Research findings: ${JSON.stringify(research)}. ` +
    `Create an isolated git worktree branched from the latest main (after batch-1/2/3 have merged). Follow strict TDD: run the narrowest relevant test/build/type-check command first to confirm the pre-bump baseline passes, bump the package(s), make the minimum code change the research calls for, then re-run the same command until green, then run 'pnpm check --fast --no-e2e --no-install' once for repo-wide confirmation. Do not push if anything is red. Report the worktree path, branch name, exact test commands run, and whether everything is green.`
  return track.useUpdateSkill
    ? base + ` This track has a dedicated 'update' skill (assistant-ui / AI SDK upgrades) -- invoke it via the Skill tool instead of ad hoc migration steps.`
    : base
}
function verifyPrompt(track, impl) {
  return `Adversarially review the dependency upgrade in ${impl.worktreePath} (branch ${impl.branch}) for track ${track.key}. ` +
    `Check the diff against the original research note -- does it address every documented breaking change, or only the one that happened to surface as a test failure? Look specifically for silent behavior changes that wouldn't fail any existing test. ` +
    `If approved, push the branch and open a PR titled 'deps(${track.key}): <old> -> <new>' with a body naming the exact versions, the breaking changes addressed, and the validation command that went green. Report approved, any issues found, and the PR URL.`
}

const results = await pipeline(
  TRACKS,
  (track) => agent(researchPrompt(track), { phase: 'Research', label: `research:${track.key}`, schema: RESEARCH_SCHEMA }),
  (research, track) => agent(implementPrompt(track, research), { phase: 'Implement', label: `implement:${track.key}`, isolation: 'worktree', schema: IMPLEMENT_SCHEMA }),
  (impl, track) => agent(verifyPrompt(track, impl), { phase: 'Verify', label: `verify:${track.key}`, schema: VERIFY_SCHEMA }),
)

const opened = results.filter(Boolean).filter(r => r.approved)
const blocked = results.filter(Boolean).filter(r => !r.approved)
log(`${opened.length}/${TRACKS.length} tracks opened a PR; ${blocked.length} blocked or rejected at review`)
return { opened, blocked }
```

Note: `electron-43` and `typescript-6` are included in `TRACKS` above for completeness, but per the [sequencing note](#pr--branch-strategy) `typescript-6` should actually be run as a **separate, later** `Workflow` invocation (or the last item in a second pipeline call) once every other track's PR has merged — don't let the pipeline's natural overlap pull it forward, since its research/implementation depends on the repo being otherwise fully upgraded already. Split it out of `TRACKS` at execution time rather than trusting ordering within one `pipeline()` call.

---

## Self-review (spec coverage check)

- Low-risk batching ✅ (Phases 1-3, exact commands, no research needed).
- Grounded research before implementing ✅ (Phase 4 research stage, reuses existing docs where valid, flags staleness explicitly).
- Red/green TDD ✅ (every phase states the baseline-then-verify command pair; Phase 4 template makes it explicit per track).
- Code review on breaking changes ✅ (Phase 4 Verify stage is an adversarial second agent, not the implementer).
- Stacked PRs where it helps, independent where it doesn't ✅ (batches stacked serially, majors independent off main, with the two coupling exceptions called out).
- Team of agents / high parallelism ✅ (Phase 4 `pipeline()` over 12 tracks, no barrier between research/implement/verify stages).
- Minimize CI wall time / cost ✅ ([CI cost strategy](#ci-cost-strategy) section — local-gate-before-push is the core lever, batching absorbs the cheap 137/193 packages into 3 CI runs total).

---

## Open decisions before executing

1. **Scope for this pass:** run all of Phases 1-5, or start with just Phases 1-3 (the batches) and revisit Phase 4 once those are merged and the lockfile is stable?
2. **Electron full E2E dispatch:** the plan recommends manually triggering the full (non-smoke) desktop E2E regression for the Electron track given it crosses two majors — this is a real CI spend on a schedule/dispatch-only workflow; confirm before the agent does this.
3. **`typescript-6` and `@types/node`-26 and `babel-8`:** all three may end up re-confirming a "deferred/pinned" outcome rather than landing, per their known/suspected blockers. Fine to let the research stage land on that conclusion, or should these be explicitly skipped this pass and only the audit doc updated?
