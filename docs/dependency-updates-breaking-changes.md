# Dependency upgrades: breaking changes and migration notes

**Companion document:** This pairs with [`dependency-version-updates-report.md`](./dependency-version-updates-report.md), which lists **current → latest** versions for **direct** dependencies across the pnpm workspace (`pnpm outdated -r`).

**Generated:** 2026-06-10 (same generation window as the companion report; re-run both after changing dependencies.)

**Scope:** Focus is on **semver-major** jumps and a small set of **high-impact minors** (databases, native/Electron, syntax highlighting, or tools that changed defaults). Patch-level updates are generally omitted unless they are called out upstream as behavior-changing.

**How to use this doc**

1. Open the companion report and sort your upgrade batch by risk (majors first).
2. For each package below, skim **What to verify** and follow the **References** links for authoritative changelogs.
3. After upgrading, run the repo’s normal checks (`pnpm check`, tests, desktop e2e if Electron changed, etc.).

---

## Snapshot: semver-major upgrades (from the companion report)

These rows are **major** semver bumps (`current` → `latest`) at the time the report was generated.

| Package | Current | Latest | Primary risk area |
| --- | --- | --- | --- |
| `typescript` | 5.9.3 | 6.0.3 | Compiler defaults, `tsconfig`, editor/CI alignment |
| `electron` | 41.2.1 | 42.3.3 | Desktop shell, Chromium/Node runtime changes, packaging |
| `vercel` (CLI) | 50.44.0 | 54.10.2 | Deploy scripts, CLI flags, remote project behavior |
| `knip` | ~~5.88.1~~ 6.24.0 | 6.24.0 | Unused-code analysis, JSON reporters, Node engine — **DONE**, see Knip section below |
| `@codecov/vite-plugin` | 1.9.1 | 2.0.1 | Vite build + Codecov upload wiring |
| ~~`react-helmet-async`~~ | 2.0.5 | 3.0.0 | **REMOVED** 2026-08-15 (BST-1281) — replaced by a single-writer `useDocumentTitle` hook; see section below |
| `@commitlint/cli` | 20.5.0 | 21.0.2 | Git hook / CI commit-message validation |
| `@commitlint/config-conventional` | 20.5.0 | 21.0.2 | Conventional commit rule defaults |
| `@commitlint/types` | 20.5.0 | 21.0.1 | Commitlint TypeScript API consumers |
| `concurrently` | 9.2.1 | 10.0.3 | Local script orchestration |
| `syncpack` | 14.3.0 | 15.3.1 | Dependency lint/fix commands and config schema |

---

## TypeScript (`typescript` 5.x → 6.x) — completed

**Status:** Upgraded to `^6.0.3` workspace-wide (34 `package.json` files: root + 33 packages). Landed 2026-07-06 in the `chore/deps-typescript-6` track, after every other Phase 4 track had merged (per the sequencing note in the dependency-upgrade-workflow plan — repo-wide compiler change, land last).

**Why it matters:** Major compiler releases can change defaults, diagnostics, and editor behavior even when application source looks unchanged.

**Breaking changes hit and fixed:**

1. **`baseUrl` deprecated (TS5101, error-level).** TS 6.0 deprecates `baseUrl` ahead of 7.0 removal. Every `tsconfig*.json` in the repo declared `"baseUrl": "."` purely to support `paths` mappings — removed `baseUrl` everywhere and, per the documented migration, prefixed the root `tsconfig.json`'s previously-bare `paths` values (e.g. `packages/types/src`) with `./` so they stay resolvable without `baseUrl` (TS5090: non-relative `paths` values require `baseUrl`; every other tsconfig's `paths` values already used a `../` prefix and needed no change).
2. **tsup 8.5.1 re-injects `baseUrl: "."` in its DTS bundling step** (confirmed upstream bug, [egoist/tsup#1388](https://github.com/egoist/tsup/issues/1388) — tsup unconditionally passes `baseUrl: compilerOptions.baseUrl || "."` to its internal `rollup-plugin-dts` TypeScript program regardless of the project's own tsconfig). Not fixable from this repo's config. Added `"ignoreDeprecations": "6.0"` to the shared `packages/config/tsconfig/base.json` as the documented bridge flag — it only silences the deprecation diagnostic, it does not change type-checking behavior. Remove once tsup ships a fix.
3. **`FileSystemDirectoryHandle` mock shape (the originally-documented blocker).** TS 6.0's DOM lib always includes the async-iterable members (`keys()`, `values()`, `[Symbol.asyncIterator]()`) on `FileSystemDirectoryHandle`. `packages/utils/src/__tests__/report-generator.test.ts` asserted partial mocks directly `as FileSystemDirectoryHandle` (a same-shape structural cast); TS 6.0 now rejects that because the mocks don't implement the new members. Fixed by routing the cast through `as unknown as FileSystemDirectoryHandle`, matching the pattern every other test file in the package already used for the same scenario — the mock's shape and the tests' actual behavior are unchanged.
4. **Stricter composite-project `rootDir`/file-list enforcement (TS6059/TS6307).** TS 6.0 tightened enforcement so that a `paths` mapping resolving into another package's `src/*` (instead of its built `dist/*.d.ts`) is now a hard error in any `composite: true` + explicit `rootDir` project, because the sibling package's source files fall outside the consuming project's `rootDir` and aren't in its `include` file list. This was a **pre-existing latent inconsistency** (most tsconfigs already pointed at `dist`, a handful pointed at `src`) that only surfaced under 6.0's stricter checking. Fixed the `src`-pointing `paths` entries to point at `dist/*.d.ts` (matching the already-correct majority pattern) in: `packages/hooks/tsconfig.json`, `packages/ui/tsconfig.json`, `packages/app-state/tsconfig.json`, `packages/db-explorer/tsconfig.json`, `packages/app-shell/tsconfig.json`, `packages/app-shell/tsconfig.typecheck.json`, `packages/workers/tsconfig.json` (dead/unused mapping, fixed for consistency), and `packages/agent/tsconfig.json` (also had a pre-existing wrong-depth `../../assistant-contract` path, corrected to `../assistant-contract/dist/*.d.ts` in the same edit).
5. **`noUncheckedSideEffectImports` defaults to `true`.** A bare side-effect import (`import '@xterm/xterm/css/xterm.css'` in `packages/app-shell/src/terminal-panel/terminal-panel.tsx`) now requires a resolvable module or an ambient declaration (TS2882). `vite/client`'s wildcard `declare module '*.css' {}` did not satisfy the check for this package-scoped (non-relative) specifier. Added a targeted `declare module '@xterm/xterm/css/xterm.css';` to the existing `packages/app-shell/src/types/vite-assets.d.ts` (which already held similar targeted ambient declarations for other Vite asset imports).

**Validation:** `pnpm run type-check` (turbo-orchestrated, all 76 package tasks) green from a fully forced (`--force`, zero cache hits) run; `pnpm --filter @brainstrike/utils test` (666 tests) and the full `pnpm check --fast --no-e2e --no-install` gate (lint-all, build, type-check, test:fast — 1576 tests across 158 files — test:browser) all green.

**Pointers**

- Handbook release notes: [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).
- Announcement: [Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).
- tsup DTS `baseUrl` injection bug: [egoist/tsup#1388](https://github.com/egoist/tsup/issues/1388).

---

## Electron (`electron` 41.x → 42.x)

**Why it matters:** Electron majors track Chromium/Node bumps and occasionally change behavior of `BrowserWindow`, `WebContents`, sessions, and PDF handling.

**What to verify**

- **PDF rendering:** PDF content may no longer use a separate guest `WebContents`. Audit any code that detects PDFs by inspecting “guest” web contents; prefer frame-tree / navigation APIs described in upstream docs.
- **Cookies:** The `session.cookies` “changed” event may report different `cause` values; update any logic that pattern-matches old cause strings.
- **WebContentsView lifecycle:** `webContents` may be unavailable in `destroyed` handlers—avoid touching `webContents` during teardown.

**Pointers**

- Electron breaking-change catalog: [Breaking changes](https://www.electronjs.org/docs/latest/breaking-changes).
- Release blog / notes for the target line: [Electron release blog](https://www.electronjs.org/blog).

---

## Vercel CLI (`vercel` 50.x → 54.x)

**Why it matters:** CLI majors often adjust subcommands and flags—especially for **Blob** workflows.

**What to verify**

- Re-check every scripted `vercel` invocation, including deploy, env, pull, link, and blob commands; this is now a multi-major jump.
- If you use `vercel blob` in scripts or CI, verify required flags and replacement flags against the release notes for each crossed major.
- Run a claimable preview deploy before changing production deploy automation.

**Pointers**

- CLI releases: [vercel/vercel releases](https://github.com/vercel/vercel/releases).
- Product changelog context: [Vercel changelog](https://vercel.com/changelog) (search for CLI scoping / blob changes).

---

## Knip (`knip` 5.x → 6.x) — DONE (bumped to 6.24.0)

**Status:** Root workspace `knip` devDependency bumped `^5.88.1` → `^6.24.0` (`chore/deps-knip-6`, off `chore/deps-batch-3-minor`). `apps/web`'s `package.json` had already independently pinned `knip: ^6.24.0` on this branch's earlier batch commits, but that entry is dead weight — `apps/web` has no `knip` script; the only invocation in this repo is the root `pnpm knip` script (no CLI flags), reading `knip.jsonc`.

**Why it matters:** Knip 6 switches parsing/resolver internals (TypeScript-compiler-based parsing/resolution replaced by `oxc-parser`/`oxc-resolver`) and tightens CLI compatibility.

**Verified non-issues for this repo:**

- **Node.js:** Knip 6.24.0 requires `^20.19.0 || >=22.12.0`. Repo pins Node 24.x — clears comfortably.
- **CLI flags removed/renamed:** `--include-libs` / `--isolate-workspaces` are gone (folded into default behavior); `pnpm knip` passes zero CLI flags anywhere in this repo, so nothing to update.
- **JSON reporter shape:** v6 emits `{issues: [...]}` only (no top-level `files`, per-issue `files` folded in); the repo never invokes `--reporter json` or parses knip's programmatic output.
- **`classMembers` issue type dropped** (replaced by `namespaceMembers`/`nsExports`/`nsTypes` for TS namespace support): the only `namespace` keywords in the codebase (`packages/types/src/env.d.ts`, `apps/desktop/e2e/global.d.ts`) are `declare global { namespace NodeJS { ... } }` ambient augmentations of the built-in `NodeJS` namespace, not user-defined namespaces with member exports — confirmed empirically, a full `pnpm knip` run produced zero `namespaceMembers`/`nsExports`/`nsTypes` findings.
- **Sibling-workspace unlisted-dependency detection regression** (knip #1792, spanning 5.7.0–6.16.1): requires npm/yarn's hoisted `node_modules` linker; this repo uses pnpm's strict per-package linking and always invokes knip from the workspace root, so it's unaffected — and the underlying issue was fixed in 6.17.0 anyway, well below the 6.24.0 target.
- **`deslop`/`doctor.config.ts` ↔ `knip.jsonc` schema coupling** (the cross-package dependency this track's plan entry called out for re-verification, per `AGENTS.md`'s `REACT DOCTOR` section): `doctor.config.ts` mirrors two knip-owned config properties by hand — `rules.exports: "off"` and the curated `ignoreDependencies` allowlist (deslop cannot express per-dependency ignores, so it disables its own `unused-dependency`/`unused-dev-dependency`/`unused-export`/`unused-type` rules and defers to `pnpm knip` instead). Both properties are unchanged, top-level `knip.jsonc` schema keys in knip 6.24.0 (verified against the installed package; no schema migration was needed for either). Confirmed by running both tools post-bump: `pnpm knip` still reports `rules.exports: "off"` behavior (a single "Unused exported types" finding, not an exports-checking flood), and `pnpm run react-doctor` runs clean against the same pre-existing advisory backlog (981 issues, matching the documented React-Doctor-migration baseline) with no new dependency/export-rule false-positive spike from the deslop side. The coupling is intact; no `doctor.config.ts` change was required.

**Real-world before/after diff** (`pnpm knip`, full turbo build first so workspace `dist/` resolves): substantive findings (Unused files / dependencies / devDependencies / exported types) were a **strict subset improvement, zero regressions** — v6's oxc-based resolver correctly stopped flagging 2 files (`packages/db/src/evaluation/retrieval-eval-cli.ts`, referenced only from a `package.json` script; `packages/vector-management/styles.css`, referenced only via `package.json#exports`) and 1 exported type (`DimensionIndexMaintenanceStatus`, re-exported from `packages/db/src/index.ts`'s public barrel) that were real false positives under v5. `Unused dependencies`/`Unused devDependencies` lists are byte-identical before/after. The `Configuration hints` section grew (91 → 143) purely from new hint categories in v6's config-linting (e.g. flagging `.d.ts`/`.json` extension registration, `packages/fonts` workspace) — advisory only, not gating.

**Pre-existing, unrelated to this bump:** `knip.jsonc`'s per-workspace `"typescript": {"config": "tsconfig.json"}` blocks are not a recognized property in knip's official schema under either version and are silently inert both before and after — worth a follow-up cleanup, not a regression.

**Pointers**

- Knip v6 announcement: [Announcing Knip v6](https://knip.dev/blog/knip-v6).

---

## Commitlint (`@commitlint/*` 20.x → 21.x)

**Why it matters:** Commitlint majors can change parser presets, default rules, and TypeScript-facing types used by local hooks or CI checks.

**What to verify**

- Run the commitlint configuration against representative valid and invalid commit messages before bumping.
- If any local scripts import `@commitlint/types`, compile those scripts against the new type surface.
- Check lefthook/CI output formatting so failed commit messages remain actionable.

**Pointers**

- Releases: [commitlint releases](https://github.com/conventional-changelog/commitlint/releases).

---

## concurrently (`concurrently` 9.x → 10.x)

**Why it matters:** Local development scripts depend on process orchestration semantics, signal handling, and output prefixes.

**What to verify**

- Run scripts that spawn multiple long-lived processes, especially desktop/web dev commands.
- Confirm Ctrl-C and child-process failure behavior still stops the expected process group.
- Check any script that depends on output prefix formatting.

**Pointers**

- Releases: [concurrently releases](https://github.com/open-cli-tools/concurrently/releases).

---

## syncpack (`syncpack` 14.x → 15.x)

**Why it matters:** Dependency lint/fix behavior is part of the repo hygiene gate.

**What to verify**

- Run `pnpm deps:lint` and `pnpm deps:update:check` before and after the bump.
- Check whether `syncpack` config keys or command output changed before updating CI expectations.

**Pointers**

- Releases: [syncpack releases](https://github.com/JamieMason/syncpack/releases).

---

## jsdom (`jsdom` 29.0.x → 29.1.x)

**Why it matters:** The v28 → v29 major transition is already crossed in this repo. The current companion report shows a 29.0.x → 29.1.x minor update, which can still affect tests that assert on CSS/DOM edge cases.

**What to verify**

- Keep the jsdom 29 **Node version policy** in mind when changing test runtime configuration.
- Re-run suites that touch `getComputedStyle`, stylesheet metadata, media queries, or fetch edge cases.

**Pointers**

- Release notes: [jsdom v29.0.0](https://github.com/jsdom/jsdom/releases/tag/29.0.0).

---

## Shiki / `@shikijs/*` (`shiki` / `@shikijs/langs` / `@shikijs/themes` 4.0.x → 4.2.x)

**Why it matters:** The v3 → v4 major transition is already crossed in this repo. The current companion report shows a 4.0.x → 4.2.x minor update, which can still affect syntax highlighting output and bundled grammar/theme behavior.

**What to verify**

- **Node:** Keep the v4 Node baseline in mind when changing the repo engine or docs build runtime.
- **Renames:** The v4 API rename risk should already be handled; re-run code search for removed v3 names if syntax-highlighting code changes.
- **Themes/langs packages:** Keep `shiki`, `@shikijs/langs`, and `@shikijs/themes` on compatible major lines together.

**Pointers**

- Migration guide: [Shiki migration](https://shiki.style/guide/migrate).
- v4 announcement: [Shiki v4.0.0](https://shiki.style/blog/v4).

---

## Codecov Vite plugin (`@codecov/vite-plugin` 1.x → 2.x)

**Why it matters:** Major bumps may realign the plugin with `@codecov/bundler-plugin-core` v2 and newer Vite majors.

**What to verify**

- Compare your Vite version against the plugin’s supported matrix in the Codecov docs / issue tracker.
- Re-check **upload token** env vars and CI debug logging if uploads fail after upgrade.

**Pointers**

- Releases: [codecov-javascript-bundler-plugins releases](https://github.com/codecov/codecov-javascript-bundler-plugins/releases).
- Docs hub: [Codecov JavaScript bundler plugins](https://docs.codecov.com/docs/javascript-bundle-analysis) (navigate to Vite quick start).

---

## react-helmet-async — REMOVED (not upgraded)

**Outcome (2026-08-15, BST-1281):** `react-helmet-async` is **gone from the repo**. There is no version of it to upgrade to or stay pinned on; the 2.x → 3.x question below is retained only as the evidence trail for why removal was the answer.

**Why removal rather than the 3.x bump:** the blocker recorded further down is architectural, not a packaging bug. 3.x's `React19Dispatcher` does not dedupe `<title>`/`<meta>` across simultaneously-mounted `Helmet` instances, and `packages/app-shell/src/root-layout-content.tsx` keeps every visited tab mounted (`mountedTabs`) — so the app really does have several writers alive at once. Swapping to React 19's native document metadata directly is the *same* mechanism (that is precisely what `React19Dispatcher` delegates to) and React documents the behaviour of multiple simultaneous `<title>` tags as undefined, so it would inherit the identical defect. The only construction that is correct under React 19 is **one writer**, which is what replaced the library.

**Replacement:** `useDocumentTitle` (`packages/app-shell/src/use-document-title.ts`) — a single hook keyed on the panel-layout store's `activeTab`/`settingsOpen`, mounted exactly once in `apps/web/src/app/root-layout-content.tsx`. It writes `document.title` and one `<meta name="description">`; every page component (`layout.tsx`, `context-explorer-page-content.tsx`, `settings/page-content.tsx`) now writes no document metadata at all. `lang="en"` needed no runtime writer either — `apps/web/index.html` already carries it as static markup.

**Test gap closed:** the "invisible to this repo's existing tests" bullet below was the real hazard. `apps/web/src/app/__tests__/document-title.test.tsx` now mounts both tab surfaces simultaneously and asserts **exactly one** `<title>` and one `<meta name="description">`, plus that neither page component emits either tag on its own; `packages/app-shell/src/__tests__/use-document-title.test.tsx` covers the route mapping and the settings-overlay precedence. A future per-surface metadata writer fails these.

**Also removed with it:** `apps/web/src/react-helmet-async.d.ts` (the hand-written React 19 type shim), the `catalog:` entry plus the `react-helmet-async>react` / `>react-dom` `overrides` in `pnpm-workspace.yaml`, the dependency in `apps/web/package.json` and `apps/desktop/package.json` (desktop declared it but never imported it), the `knip.jsonc` `ignoreDependencies` entry, and the `optimizeDeps` prebundle entry in `packages/build-utils/src/vite.ts`.

---

### Historical evidence (2026-07-06 investigation of the 2.x → 3.x bump)

**Why it mattered:** Mostly type/API cleanup and React 19–oriented peer dependency alignment. 3.0.0 was still the latest release as of 2026-07-06 (verified via `npm view react-helmet-async versions`).

**Status (verified 2026-07-06):** The `preserveSymlinks: true` + `exports`-field failure is **real and still reproducible**, but it is scoped to `apps/web/vitest.config.mts` only (the only place in the repo that sets `preserveSymlinks`) — neither `apps/web/vite.config.mts` nor `apps/desktop/vite.config.mts`/`vitest.config.mts` set it, and `apps/web`'s production `vite build` with react-helmet-async@3.0.0 succeeds cleanly. Vite is already at 8.1.3 in this repo (well past the version current when the pin was first made); the newer Vite did **not** fix the underlying resolution behavior.

**Root cause, confirmed by direct repro:** it isn't `react-fast-compare` specifically — 3.0.0's `exports` map (`{ ".": { import: {...}, require: {...} } }`) only covers react-helmet-async's own entrypoint. Under `preserveSymlinks: true`, Vite's resolver stops following pnpm's symlinked `node_modules` layout to reach react-helmet-async's own *non-hoisted* runtime dependencies (`react-fast-compare`, `shallowequal`, `invariant` — none of which declare an `exports` field, so this isn't really an exports-field bug in the strict sense, it's a symlink-traversal + strict-resolution interaction). All three failed to resolve one at a time as each prior one was aliased around, in this exact vitest run:
  - `Failed to resolve import "react-fast-compare" from ".../react-helmet-async/lib/index.esm.js"`
  - then `Failed to resolve import "shallowequal" from ".../react-helmet-async/lib/index.esm.js"`
  - then `Failed to resolve import "invariant" from ".../react-helmet-async/lib/index.esm.js"`

**Workaround tried and verified working:** adding all three as `resolve.alias` entries in `apps/web/vitest.config.mts`, pointed at their resolved files in the root `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/index.js`, makes every previously-failing suite pass (`layout.test.tsx`, `context-explorer-page-content.test.tsx` + `.fallback.test.tsx`, `page-content.test.tsx`, `page-content.operations.test.tsx` — 10/10 tests green) and the full `apps/web` unit suite still passes (168 passed / 5 skipped, 0 failed) with react-helmet-async bumped to `^3.0.0` in both `apps/web/package.json` and `apps/desktop/package.json`. This is the complete dependency set (react-helmet-async 3.0.0's `dependencies` are exactly `invariant`, `react-fast-compare`, `shallowequal` — no others), so it is not an open-ended whack-a-mole; it needs exactly these 3 aliases and no more, confirmed by re-running after each one was added.
  - Not tried/needed: disabling `preserveSymlinks` outright — the repo's monorepo-wide pnpm symlink layout is exactly what `preserveSymlinks: true` exists to route around elsewhere in the same config (28+ workspace-package aliases), so turning it off is much higher blast radius than 3 targeted aliases and was not necessary once the workaround above proved sufficient.

**Other repo-specific finding:** `apps/web/src/react-helmet-async.d.ts` is a hand-written `declare module 'react-helmet-async'` shim added because 2.0.5's shipped types don't satisfy React 19.2's stricter JSX component types. react-helmet-async 3.0.0 ships updated types built on `PropsWithChildren<HelmetProps>` (its package description now says "native support for React 19+"). Verified: `apps/web` type-checks clean (`tsc --noEmit`, zero errors) both **with** the shim present (harmlessly shadowed) and **with the shim file deleted** — so the shim becomes dead code once this upgrade lands and should be removed as part of the same change, not left behind.

**Actual blocker (found on adversarial review, 2026-07-06 — supersedes the exports/`preserveSymlinks` issue above as the reason this stays pinned):** the `preserveSymlinks` workaround above is real and sufficient to get a green build/test run, but a green suite does not mean the upgrade is safe. 3.0.0 introduces a new `React19Dispatcher` runtime path (`src/React19Dispatcher.tsx`) that fully replaces the legacy Context/DOM-mutation dispatcher whenever `React.version` major `>= 19` — always true here (`react ^19.2.7`). This is a mechanism swap, not a type-level change, and it is a **regression for this specific app's architecture**: `packages/app-shell/src/root-layout-content.tsx` keeps hidden tab content mounted (`mountedTabs`) rather than unmounting on tab switch, so multiple `<Helmet>` instances (e.g. `ContextExplorerPageContent` and `SettingsPageContent`) are simultaneously mounted in practice, not just in theory.
  - Confirmed by direct reproduction (isolated jsdom probe, two simultaneously-mounted `<Helmet>` instances with different `<title>`/`<meta name="description">`): **2.0.5** collapses to exactly 1 `<title>` and 1 `<meta name="description">` in the DOM (last-mounted wins — correct). **3.0.0** leaves **2 of each tag coexisting in the DOM with no cross-instance dedup** — a reachable SEO/DOM-correctness regression the moment a user has visited more than one tab.
  - Invisible to this repo's existing tests: `layout.test.tsx` and `context-explorer-page-content.test.tsx` each render their `Helmet` in isolation — no test exercises two simultaneously-mounted `Helmet`s, so this would have shipped silently.
  - Side effect of the same dispatcher swap: `onChangeClientState` and `prioritizeSeoTags` are referenced only by the legacy `HelmetDispatcher`, not by the new `React19Dispatcher` — both become silent no-ops under 3.0.0 on React 19. Not currently used by this repo's call sites (verified by grep), so no live breakage today, but worth knowing if either is ever adopted.
  - **Conclusion at the time:** stay pinned at `^2.0.5`. The `preserveSymlinks` issue is a solved problem (3-line workaround above); the `React19Dispatcher` dedup regression is not something this repo can work around without either (a) upstream fixing cross-instance title/meta dedup under the new dispatcher, or (b) this repo moving away from keeping inactive tabs mounted (out of scope for a dependency bump). **Superseded 2026-08-15 by option (c): stop needing cross-instance dedup at all** — one writer, no library. See the outcome at the top of this section.

**What to verify**

- If you use advanced SSR types, note removals/changes around server state helpers (`HelmetServerState.titleAttributes`, `MappedServerState` export). **Not applicable to this repo**: grepped for `HelmetServerState`, `MappedServerState`, `toComponent()`, and any `renderToString`/`entry-server` SSR usage — none found. `apps/web` renders `Helmet`/`HelmetProvider` client-side only (`main.tsx`, `layout.tsx`, `settings/page-content.tsx`, `context-explorer-page-content.tsx`), using only `htmlAttributes`, `<title>`, and `<meta>` children, all of which are unaffected by the 3.0.0 API changes and pass in the reproduction above.
- `HelmetDatum.toComponent()` typing now reflects array elements—adjust any custom wrappers. **Not applicable**: no code in the repo calls `toComponent()` or imports `HelmetDatum`.
- `apps/desktop/package.json` also pinned `react-helmet-async` but had **no direct import of it anywhere in `apps/desktop/src`** and neither of desktop's Vite configs set `preserveSymlinks` — desktop was unaffected either way. Its declaration and the stale mention in `apps/desktop/src/__tests__/README.md` were dropped with the removal; desktop's document title stays whatever `apps/desktop/index.html` sets, unchanged by BST-1281.

**Pointers**

- Upstream PR / discussion for v3: [react-helmet-async v3.0.0 PR #260](https://github.com/staylor/react-helmet-async/pull/260).

---

## lucide-react (`lucide-react` 1.8.x → 1.17.x)

**Why it matters:** The v0 → v1 major transition is already crossed in this repo. The current companion report shows a 1.x minor update, so treat this as an icon output/import audit rather than a brand-icon migration.

**What to verify**

- Search imports for renamed or removed icons before bumping.
- Re-run UI snapshot or component tests for surfaces with dense icon usage.

**Pointers**

- Official migration notes: [Migration from v0](https://lucide.dev/guide/react/migration).

---

## PGlite (`@electric-sql/pglite` 0.3.x → 0.4.x) — completed

**Status:** Upgraded to `^0.4.4` workspace-wide. The app is pre-release, so no on-disk data migration was required.

**Notable upstream changes (0.4.0 → 0.4.4)**

- **0.4.0:** New simplified PGlite with separate `initdb`. New experimental extensions (`pg_textsearch`, `postgis`). Default database is now `postgres` (was `template1`).
- **0.4.1:** Clear timers on exit; remove `pglite-socket` dep on `pglite-postgis`.
- **0.4.2:** Allow passing `initdb.wasm` asset for bundlers that need it.
- **0.4.3:** Default database, user, and role are all `postgres`. Background workers disabled by default. Initial memory size is configurable.
- **0.4.4:** Disable checkpointer.

**What we touched**

- Bumped six `package.json` files to `^0.4.4`: `apps/desktop`, `packages/db`, `packages/embeddings`, `packages/file-import`, `packages/token-cache`, `packages/vector-management`.
- No code changes were needed for the default `postgres` user/db (we never relied on the legacy `web_user`/`template1` defaults), the worker import path, or the new `initdb.wasm` asset (Vite already excludes `@electric-sql/pglite` from `optimizeDeps` in `apps/desktop`, `apps/web`, and `packages/db`, and the `opfs-ahp.js` / `nodefs.js` aliases are still valid in 0.4).

**Test compatibility note (jsdom)**

- PGlite 0.4 detects browser vs. Node via `typeof window === "object"`. Under jsdom that resolves to "browser" and routes through code paths that need real `Worker`/`Blob` URL support — which jsdom does not provide. The previous `factory-reset.test.tsx` was the only DbProvider test that used the **real** `wasmLoader.createPGlite` under jsdom (every other DbProvider test already mocks `createPGlite`). Its open → close → reopen cycle deadlocked under 0.4.
- Resolution: the test was rewritten to follow the established mock pattern (matching `clear-data.test.tsx`, `db-provider-lifecycle.test.tsx`, etc.) and now actually asserts that `close()` is called on the original instance and a fresh PGlite is provisioned by the retry-init path — coverage that the previous "doesn't throw" assertion didn't provide. Real PGlite open/close round-trips remain the responsibility of the browser-mode suite (`__tests__/*.browser.test.ts`).

**Pointers**

- Upgrade guide: [Upgrading between minor versions | PGlite](https://pglite.dev/docs/upgrade).
- v0.4 announcement: [Announcing PGlite v0.4](https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04).
- Changelog: [`@electric-sql/pglite` CHANGELOG](https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md).

---

## Babel (`@babel/core`, `@babel/parser`, `@babel/plugin-transform-runtime`, `@babel/runtime` 7.x → 8.x) — completed

**Status:** Upgraded all four packages to `^8.0.1` (`@babel/core`, `@babel/plugin-transform-runtime`) / `^8.0.0` (`@babel/parser`, `@babel/runtime`) across `apps/web`, `apps/desktop`, `packages/chunking-worker`, and `packages/db`.

**Compatibility gate (checked first):** `babel-plugin-react-compiler` (pinned `1.0.0`) only declares `@babel/types: ^7.26.0` as a runtime dependency in its published package.json — `@babel/core`/`@babel/traverse`/`@babel/generator` are devDependencies bundled into its published `dist/index.js` at build time, so the plugin is host-Babel-version-agnostic by design. The real compatibility boundary is `@rolldown/plugin-babel@0.2.3` (used via `@vitejs/plugin-react@6`'s `reactCompilerPreset`), whose published peerDependencies already declare `"@babel/core": "^7.29.0 || ^8.0.0-rc.1"` (same shape for `@babel/plugin-transform-runtime`/`@babel/runtime`) — `pnpm install` resolved the whole 42-project workspace with zero peer warnings.

**Live end-to-end proof**

- Constructed the exact plugin object `apps/web/vite.config.mts` creates (`@rolldown/plugin-babel({ exclude, presets: [reactCompilerPreset({})] })`) and drove it through its real async Vite/Rolldown lifecycle (`configResolved` → `outputOptions` → `transform.handler`) against a real repo component (`apps/web/src/app/layout.tsx`) using the installed `@babel/core@8.0.1` — produced correct React Compiler output (memo-cache sentinels, `react/compiler-runtime` import).
- `packages/chunking-worker`'s full test suite (its `babel-adapter.ts` is the only direct `@babel/parser` API consumer in the repo): 171/171 tests pass with `@babel/parser@8.0.0`.

**What we touched**

- Bumped `apps/web/package.json`, `apps/desktop/package.json` (`@babel/core`, `@babel/plugin-transform-runtime`, `@babel/runtime`), and `packages/chunking-worker/package.json`, `packages/db/package.json` (`@babel/parser`).
- Fixed `packages/chunking-worker/src/parsers/babel-adapter.ts`: `@babel/parser@8`'s `ParserPlugin` type dropped `'classProperties'`, `'classPrivateProperties'`, `'classPrivateMethods'`, `'dynamicImport'`, `'importAttributes'`, and `'topLevelAwait'` (those syntaxes now parse unconditionally, so the opt-in flags were removed from the type/registry — the runtime still silently tolerates unknown plugin-name strings, but `tsc --noEmit` fails on them). `buildPlugins()` now only pushes `'decorators-legacy'` (still a real, meaningful opt-in) plus conditional `'jsx'`/`'typescript'`. Verified byte-identical AST output before/after on a fixture exercising all six affected syntaxes, and the full chunking-worker suite (171/171) plus its `type-check` stayed green (only the 3 pre-existing unbuilt-package `@brainstrike/text-splitter`/`@brainstrike/utils` errors remain, present identically on the unmodified base commit).

**Surveyed and confirmed not applicable**

- No use of Babel 8's removed sync convenience APIs (`transform()`/`parse()`/`transformFromAst()` → `*Sync()` variants) — only the async APIs (`transformAsync`/`loadOptionsAsync`) are used, via `@rolldown/plugin-babel`.
- `@babel/plugin-transform-runtime`'s removed `useBuiltIns`/`corejs`/`useESModules` options aren't configured anywhere; the plugin is declared in `apps/web`/`apps/desktop` package.json but not wired into either `vite.config.mts`'s `runtimeVersion` option (dormant).
- No `@types/babel__*` packages to reconcile (Babel 8 bundles its own types).
- Node ^22.18.0 || >=24.11.0 requirement already satisfied (repo pins Node 24.x).

**Pointers**

- Babel 8 migration guide: [babeljs.io blog — Babel 8 release](https://babeljs.io/blog).
- `@rolldown/plugin-babel`: [npm package](https://www.npmjs.com/package/@rolldown/plugin-babel).

---

## Assistant UI (`@assistant-ui/react` 0.12.x → 0.14.x, `@assistant-ui/react-markdown` 0.12.x → 0.14.x, `@assistant-ui/react-data-stream` 0.12.11 → 0.12.18, `@assistant-ui/styles` deprecated) — completed

**Status:** `@assistant-ui/react` bumped `~0.12.25` → `~0.14.26`, `@assistant-ui/react-markdown` `^0.12.9` → `^0.14.5`, `@assistant-ui/react-data-stream` `^0.12.11` → `^0.12.18` across `packages/ui`, `apps/web`, `apps/desktop`. `@assistant-ui/styles` stays pinned at `^0.3.7` (see below — there is no newer version and no drop-in replacement package).

**Why it matters:** This is the highest-blast-radius dependency in the repo — `packages/ui`'s `assistant-ui-panel/*` wraps it directly, and `AGENTS.md`'s ASSISTANT RESILIENCE / PERMISSION ENGINE / ASSISTANT THREAD PERSISTENCE sections all layer custom logic on top of its primitives and hooks.

**Root cause of the composer breakage (0.12.26): trigger-popover unification**

Two upstream PRs landed together in the `0.12.26` release (published 2026-04-24, both merged 2026-04-15):

- [#3827 "unify mention and slash command under Unstable_TriggerPopover"](https://github.com/assistant-ui/assistant-ui/pull/3827) replaced the nested `Unstable_MentionRoot` + `Unstable_SlashCommandRoot` pattern with a single `Unstable_TriggerPopoverRoot` hosting one or more `Unstable_TriggerPopover` declarations (each with its own `char`, e.g. `"@"` or `"/"`) as **siblings**, not nested wrappers. `Unstable_TriggerPopoverPopover` was folded into `Unstable_TriggerPopover` itself (it now renders the `role="listbox"` container directly).
- [#3834 "TriggerPopover v2 (Directive/Action)"](https://github.com/assistant-ui/assistant-ui/pull/3834) replaced the `onSelect: {type, ...}` discriminated union with declarative `<TriggerPopover.Directive>` (insert a directive chip, e.g. "@" mentions) / `<TriggerPopover.Action>` (fire a handler, e.g. "/" slash commands) child sub-primitives — exactly one per `TriggerPopover`. It also renamed `unstable_useToolMentionAdapter` → `unstable_useMentionAdapter` and changed `unstable_useSlashCommandAdapter`'s command shape from `{name, ...}` to `{id, ...}`, with the hook now returning `{adapter, action, iconMap?, fallbackIcon?}` (previously just the adapter).

**Behavior-preservation gotcha:** the new `TriggerPopover.Action`'s `removeOnExecute` defaults to `false` (favors leaving a directive chip as an audit trail) — the OLD `Unstable_SlashCommandRoot`'s docs stated selecting a command always removed the `/command` text. We set `removeOnExecute: true` explicitly in `toSlashCommandAdapterOptions` (`packages/ui/src/assistant-ui-panel/slash-commands.ts`) to preserve the original behavior; leaving it unset would have been a silent regression that no type error would catch.

**Files touched:** `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` (nested-roots → single shared `Unstable_TriggerPopoverRoot`, hook destructuring), `composer-trigger-popover.tsx` and `composer-mention-popover.tsx` (popover content moved to be the `TriggerPopover`'s own children instead of a separate `Popover` wrapper; `Directive`/`Action` behavior sub-primitives added), `file-mentions.ts` (adapter type re-derived from `Unstable_TriggerPopover`'s `adapter` prop instead of the removed `Unstable_MentionRoot`), `slash-commands.ts` (`name` → `id`, `removeOnExecute: true` added), plus test/mock updates in `__tests__/assistant-ui-panel.test.tsx`, `assistant-ui-panel/__tests__/slash-command-api-guard.test.ts`, `slash-commands.test.ts`.

**Other breaking changes hit in the same bump (unrelated to the composer):**

- `ToolCallMessagePart` gained a required `respondToApproval` field (tool-approval type surface) — test fixtures in `tool-fallback.test.tsx` / `tool-fallback.browser.test.tsx` needed a no-op stub added alongside the existing `addResult`/`resume` stubs. The real `ToolFallback` component doesn't read this field, so this is fixture-only.
- `ChatModelRunOptions.config` (a legacy alias mirroring `.context`) was removed per the official [Migration to v0.14](https://www.assistant-ui.com/docs/migrations/v0-14) guide — a stale test fixture in `local-runtime-adapter.test.ts` had a dead `config: {}` field that no longer type-checks; removed (the real adapter never read it).
- The `components` prop on `ThreadPrimitive.Messages` / `MessagePrimitive.Parts` / etc. is soft-deprecated in favor of a children render-function pattern, but **still works** in 0.14 (removal is a future minor) — this repo's 4 `components={{...}}` call sites in `assistant-ui-panel.tsx` were left as-is; migrating them is optional follow-up, not required for this bump.

**What did NOT change:** `@assistant-ui/react-markdown`'s actual exports (`MarkdownTextPrimitive`, `unstable_memoizeMarkdownComponents`, `SyntaxHighlighterProps`) and its `styles/dot.css` file are byte-identical between 0.12.9 and 0.14.5 — no code changes needed there. `@assistant-ui/react-data-stream` is not imported anywhere in this repo's actual code (only referenced defensively in Vite `optimizeDeps`/`knip.jsonc` config) and its peer dependency is only against `react`, not `@assistant-ui/react`, so it has no version-lockstep constraint with the other three packages.

**`@assistant-ui/styles` (deprecated) — no replacement package exists:** upstream deleted the entire `packages/styles` workspace package from the assistant-ui monorepo in [PR #3234 "chore: remove `styles` package"](https://github.com/assistant-ui/assistant-ui/pull/3234) (merged 2026-02-06), the same day `0.3.7` — the last version ever published — went out. The npm registry now marks it fully deprecated ("Package no longer supported"). There is no newer version and no drop-in successor package; the recommended go-forward path (per the removed docs' "Not using Tailwind" tab deletion) is the Tailwind-based [shadcn/ui component registry](https://www.assistant-ui.com/docs/ui/styled/thread) (`npx assistant-ui@latest add thread` or `npx shadcn@latest add https://r.assistant-ui.com/thread`), which ships components with their own Tailwind classes instead of importing a separate stylesheet. This repo already uses Tailwind and imports `@assistant-ui/styles/index.css` purely for the library's base CSS custom properties (`overrides.css` layers `--bs-*` tokens on top) — migrating off it entirely would mean re-deriving those base tokens from the shadcn registry's CSS, which is a larger follow-up than this dependency bump warrants. `^0.3.7` is kept pinned (it is already the newest — and final — version on npm).

**Pointers**

- Composer primitive unification: [PR #3827](https://github.com/assistant-ui/assistant-ui/pull/3827), [PR #3834](https://github.com/assistant-ui/assistant-ui/pull/3834).
- Official migration guide: [Migration to v0.14](https://www.assistant-ui.com/docs/migrations/v0-14), [Deprecation Policy](https://www.assistant-ui.com/docs/migrations/deprecation-policy).
- Styles package removal: [PR #3234](https://github.com/assistant-ui/assistant-ui/pull/3234), [PR #2852 "rewrite styles package"](https://github.com/assistant-ui/assistant-ui/pull/2852) (the Nov 2025 predecessor change).
- shadcn/ui registry: [Styled Thread docs](https://www.assistant-ui.com/docs/ui/styled/thread).

---

## Assistant UI (`@assistant-ui/react` 0.14.26 → 0.15.8, `@assistant-ui/react-markdown` 0.14.5 → 0.14.8, `assistant-stream` 0.3.25 → 0.3.34) — completed; scrolling moved IN-REPO

**Status:** `@assistant-ui/react` bumped `~0.14.26` → `~0.15.8`, `@assistant-ui/react-markdown` `^0.14.5` → `^0.14.8` (its `@assistant-ui/react` peer range flips to `^0.15.0` at 0.14.8 — the two must move together), and the repo's `assistant-stream` pins (`packages/assistant-ui`, `packages/agent`) `0.3.25` → `0.3.34` in lockstep with `@assistant-ui/core@0.3.7`'s own `^0.3.34` dependency. Landed 2026-08-06/07 on `chore/deps-assistant-ui-0.15`. The upgrade's headline consequence: **tier-1 thread scrolling is now repo-owned** (`packages/assistant-ui/src/thread-scroll-follow.tsx`) and the library's viewport auto-scroll is out of the loop entirely — see below.

**v0.15 breaking changes that actually hit this repo** (official guide: [Migration to v0.15](https://www.assistant-ui.com/docs/migrations/v0-15); the removed-hook surface here was tiny because the v0.14 migration already moved most code to the unified `useAui`/`useAuiState` API):

- `useAttachment` removed → `useAuiState((s) => s.attachment)` (2 call sites in `packages/assistant-ui/src/composer-attachments.tsx` — extracted from packages/ui by BST-981).
- `useComposerRuntime` removed → `useAui()` + `aui.composer.addAttachment(...)` (`composer-input.tsx`'s `AttachmentPasteFrame`).
- `useMessage` removed → `useAuiState((s) => s.message...)` (`follow-up-queue-repin.browser.test.tsx`'s growing-message harness).
- **Dual `assistant-stream` instances break the `Tool` type**: `@assistant-ui/core@0.3.x` resolves its own `assistant-stream@^0.3.34` while the repo pinned `0.3.25` — two structurally different `Tool` types coexist and `unstable_toolResultStream(context.tools ?? {}, ...)` in `data-stream-runtime.ts` fails to type-check. Fix is the lockstep pin bump, not a cast. (The 0.3.25/0.3.33 instances still in the lockfile belong to `@assistant-ui/react-data-stream@0.12.18` — declared as a dependency of `apps/web`/`apps/desktop` and listed in `packages/build-utils/src/vite.ts` externals, but no source module imports it — inert.)
- TS2883 portability: `CHAIN_OF_THOUGHT_TOOL_COMPONENTS` in `todo-progress.tsx` now needs an explicit type annotation (`by_name: Record<string, ToolCallMessagePartComponent>; Fallback: ToolCallMessagePartComponent`) because its inferred type references a non-exported `ReadonlyJSONObject` path inside the pnpm store.
- `aui.thread()` call sites (5) still type-check on 0.15 (the accessor remains callable) and were left as-is; the property form (`aui.thread`) is the documented forward direction if upstream drops the callable form in the next major.

**UPSTREAM REGRESSION found by this repo's BST-1039 browser test — the reason scrolling moved in-repo:** on every `isRunning` flip (run start AND run end), 0.15 silently unpins stick-to-bottom for a bottom-pinned thread — the reply streams below the fold and the jump chip appears with no user act, on effectively every send. Reproduced deterministically by `packages/assistant-ui/src/__tests__/follow-up-queue-repin.browser.test.tsx` (fails on 0.15.0, 0.15.4, and 0.15.8; passes on 0.14.26).

- **The regression also ships in the CURRENT 0.14 patch line.** Version sweep (same BST-1039 test, this repo): 0.14.26 green; **0.14.28 and 0.14.29 fail deterministically** — the `isRunning` subscription landed in 0.14.28's copy of the hook (0.14.27's hook is byte-identical to 0.14.26). Before this PR, the catalog range was `~0.14.26`, so ANY lockfile regeneration on main would float to 0.14.29 and ship the unpin — a latent hazard this PR closes by taking the library's engine out of the loop entirely; staying on the 0.14 line was never a safe alternative.
- **App-level workaround ruled out empirically:** two principled no-patch variants (a run-transition re-pin bridge reading live `isAtBottom`, and a BST-1039-style pre-transition `wasPinned` subscription) both fail the BST-1039 test against the unpatched library — at the public API the clamp misread is indistinguishable from a real user scroll, and it can land before any app-side effect can order around it. The fix has to live where the causality is visible: inside the engine — which is why the repo now owns it (`thread-scroll-follow.tsx`).
- **Root cause (proven by observer-instrumented trace):** 0.15's `useThreadViewportAutoScroll` added an `isRunning` subscription (`useAuiState((s) => s.thread.isRunning)`, used by the new top-anchor logic). The hook's `scrollRef = useManagedRef((el) => {...})` takes an **inline callback whose identity changes every render**; `useManagedRef` memoizes on that identity, so the returned ref changes too, and `useComposedRefs(resizeRef, scrollRef, divRef)` cascades — React detaches and re-attaches ALL viewport refs, tearing down and reconstructing the content `ResizeObserver` (`useOnResizeContent`) mid-commit. On 0.14 this instability was latent (the hook had no reason to re-render at run transitions); on 0.15 the re-render now lands in the exact commit where run-start/run-end content changes. A freshly constructed RO delivers its first observation at end-of-frame — AFTER the browser dispatches the scroll event from the content-growth clamp — so `handleScroll` reads the clamp with no in-flight-scroll bookkeeping armed, flips `isAtBottom` false, and auto-follow never re-sticks (trace: new RO pair constructed at run start → mutation commits → scroll event at stale `scrollTop` → `isAtBottom -> false` → RO's late initial fire is a no-op because the store already says unpinned).
- **THE FIX — repo-owned follow engine (supersedes the interim pnpm patch):** a vendored 5-line patch (stabilizing the hook's ref-callback identity) shipped first and proved the root cause (BST-1039 red → green with only that change). It was then REPLACED by moving the whole mechanism in-repo: `thread-scroll-follow.tsx` is a parity port of the library's algorithm with a STABLE observer lifecycle (one engine per panel, observers attached once per scroller element), the tier-1 scroller is a plain div (`ThreadPrimitive.Viewport` removed on BOTH tiers — the architecture test pins this), the jump button and `data-pinned` read the engine, and the BST-1039 dispatch re-pin fires through it. All scroll browser suites (BST-896/897/1039) now run against the engine with the UNPATCHED library installed and pass; the catalog pin returned to a normal tilde range because the buggy code path is unreachable.
- **Why ownership, not the patch or a pin-back:** upstream broke this same path twice in two lines (0.14.28, 0.15.x) while building the top-anchor mode, two app-level workarounds failed empirically (the misread is invisible at the public API), and tier 2 already owned its scrolling via the virtualizer — tier 1 now matches. The engine is ~200 lines whose bugs are ours to fix rather than re-diagnose per upstream release.
- Known cosmetic residue on 0.15 (unrelated to the engine move): the tap 0.9.10 scheduler emits React "flushSync was called from inside a lifecycle method" console warnings during streaming, and vitest-browser logs occasional "ResizeObserver loop completed with undelivered notifications" — both library-internal, no test asserts on them.

**Release-provenance note:** 0.15.6/0.15.7/0.15.8 were published manually by the lead maintainer (no OIDC attestation, unlike the project's usual GitHub Actions publishes) within ~30 minutes on 2026-08-06, out of order. Upstream's changelog explains: 0.15.8 is a republish of 0.15.6 after registry staged-version conflicts blocked 0.15.6/0.15.7. Details recorded next to the `minimumReleaseAgeExclude` entries in `pnpm-workspace.yaml`.

**Pointers**

- [Migration to v0.15](https://www.assistant-ui.com/docs/migrations/v0-15)
- [`@assistant-ui/react` CHANGELOG](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/CHANGELOG.md)
- Follow-up: report the ref-instability regression upstream (assistant-ui/assistant-ui) with the trace + patch from this repo.

---

## TanStack Table (`@tanstack/react-table` 8.21.3 → 9.0.0) — completed

**Status:** Catalog bumped `^8.21.3` → `^9.0.0`, 2026-08-06 on `chore/deps-react-table-9` (v9.0.0 stable shipped 2026-08-04). Blast radius was exactly the settings-ui log viewer (`packages/settings-ui/src/settings/system/log-viewer-components/`, 4 files + 1 new).

**v9's architectural change:** every non-core capability is an explicit opt-in plugin registered through `tableFeatures()` (which also carries row-model factories and sort/filter-fn registries), `useReactTable(options)` becomes `useTable({ features, ...options })`, and the `TFeatures` generic threads through `Table`/`Row`/`ColumnDef`/`CellContext`. `table.getState()`/top-level `onStateChange` are removed in favor of TanStack Store atoms — this repo never used either (per-slice `on*Change` handlers, which survive unchanged, were already the pattern).

**What the migration actually touched here:**

- New `log-table-features.ts`: module-scope `tableFeatures({ columnSizingFeature, columnVisibilityFeature, paginatedRowModel: createPaginatedRowModel(), rowPaginationFeature, rowSortingFeature, sortedRowModel: createSortedRowModel() })` + exported `LogTableFeatures` type. `columnSizingFeature` is required because v9 gates the per-column `size` option AND `column.getSize()` (log-list's header widths) behind it — the compiler catches the option (`TS2353`), but `getSize()` alone would be a runtime gap.
- `log-viewer.tsx`: `useTable({ features: logTableFeatures, ... })`, row-model factories dropped from options (core row model is automatic in v9), `getPrePaginationRowModel()` → `getPrePaginatedRowModel()`, `VisibilityState` → `ColumnVisibilityState`, `ColumnDef`/`CellContext` gain the `LogTableFeatures` first generic.
- `log-list.tsx` / `log-toolbar.tsx` / `log-row.tsx`: `Table<TData>`/`Row<TData>` → `Table<LogTableFeatures, TData>`/`Row<LogTableFeatures, TData>`.
- **No `sortFns` registry needed:** the only sortable column (`timestamp`) is numeric, and v9's `'auto'` resolution falls back to the built-in `sortFn_basic` for non-string, non-Date values (verified in `rowSortingFeature.utils.js`). A string-sorted column would need `sortFns: { text: sortFn_text, ... }` registered or it warns and falls back.

**v9 traps checked and NOT present in this code:** no destructured instance methods (they moved to prototypes and lose binding), no row selection (`getIsSomeRowsSelected()` semantics changed), no pinning (left/right → start/end renames), no `table.getState()`/`onStateChange`, no underscore-internal APIs, no CJS consumer of the now-ESM-only package (settings-ui is renderer/browser-bundled only).

**Validation:** settings-ui 509 unit tests, desktop 2353, web 396, full workspace type-check, and settings-ui/desktop/web production builds all green in the same run.

**Pointers**

- Migration guide: [Migrating to v9](https://tanstack.com/table/latest/docs/framework/react/guide/migrating).
- Upstream agent skill used for this migration: [migrate-v8-to-v9 SKILL.md](https://github.com/TanStack/table/blob/main/packages/table-core/skills/migrate-v8-to-v9/SKILL.md).
- Announcement: [TanStack Table v9](https://tanstack.com/blog/tanstack-table-v9-taking-form).

---

## Turborepo (`turbo` 2.8.x → 2.9.x)

**Why it matters:** Minor releases add features and sometimes deprecations ahead of v3.

**What to verify**

- Read the **2.9** blog for new defaults (for example caching knobs) and any “future flags” that touch `turbo.json`.

**Pointers**

- [Turborepo 2.9 blog](https://turborepo.dev/blog/2-9).

---

## Playwright (`@playwright/test` / `playwright` 1.58.x → 1.59.x)

**Why it matters:** Even “minor” Playwright releases can change timing, tracing, or browser revision pins.

**What to verify**

- Re-run flaky tests; watch for timing regressions in hooks or new APIs that change scheduling.
- Reinstall browsers if CI caches browsers separately (`pnpm exec playwright install`).

**Pointers**

- [Playwright release notes](https://playwright.dev/docs/release-notes).

---

## AI SDK / agents (`@ai-sdk/*`, `@mastra/*`, `@huggingface/transformers`)

**Why it matters:** These packages iterate quickly; minors may deprecate provider entrypoints or model metadata.

**What to verify**

- Run integration tests against each provider you support (OpenAI, Anthropic, Google, local).
- For `@huggingface/transformers`, re-check **WASM/WebGPU** constraints in browsers and workers after bumping minors.

**Pointers**

- AI SDK: [Vercel AI SDK releases](https://github.com/vercel/ai/releases) (and provider packages under `@ai-sdk/*`).
- Mastra: [mastra releases](https://github.com/mastra-ai/mastra/releases).
- Transformers.js: [huggingface/transformers.js releases](https://github.com/huggingface/transformers.js/releases).

### `@ai-sdk/{anthropic,openai,google,provider}` 3.x → 4.x — completed

**Status:** Upgraded `packages/agent`'s `@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai` to `^4.0.8` and `@ai-sdk/provider` to `4.0.2`, in lockstep with `@mastra/core` `^1.37.1` → `^1.49.0` (needed `>=1.47.0` for `LanguageModelV4` support — see Mastra PR #18477), `@mastra/mcp` `^1.8.1` → `^1.13.0`, and `@mastra/memory` `1.20.0` → `1.22.1` (peer-range compatibility).

**What we touched**

- `packages/agent/package.json` (the only package.json in the workspace declaring these deps).
- `packages/agent/src/providers/provider-factory.ts`: `createEmbeddingProvider`'s `openai`/`google` branches now cast `openaiProvider.embeddingModel(model)` / `googleProvider.embeddingModel(model)` with `as unknown as MastraEmbeddingModel<string>`.

**Upstream breaking changes in the 3.x → 4.x major (from `@ai-sdk/provider`'s CHANGELOG.md), and how each was addressed**

- **CommonJS exports removed; all `@ai-sdk/*@4.x` packages are ESM-only (`"type": "module"`, no `require` export condition).** Does not break `packages/agent`'s own dual ESM+CJS build (see the CJS `require()` interop note below), but is the root cause of that note — this is a silent-until-runtime change class, not something a type-check or `vi.mock`-based test would catch.
- **Minimum supported Node.js raised to 22** (was unstated/lower before). Already satisfied: `packages/agent/package.json` and the repo's Electron target both declare `engines.node: ">=22"`.
- **Reasoning/file/tool-result-output part restructuring** (tagged file parts, new `reasoning-file` type, `image-*` tool outputs rolled into `file-*`). Verified not applicable: grepped `packages/agent/src` for `image` part / file part construction — none found; this repo doesn't construct multimodal file parts through these APIs today.

**Known upstream gap (not a blocker, needs a documented cast)**

- `@mastra/core` (`1.49.0`, current latest) has **no `EmbeddingModelV4` support** in its `MastraEmbeddingModel<T>` union (`vector/vector.d.ts` still caps at `EmbeddingModelV2 | EmbeddingModelV3`) — Mastra's PR #18477 that added `LanguageModelV4` support touched zero embedding-related files. `EmbeddingModelV3` and `EmbeddingModelV4` are structurally identical (same shape, differing only by the `specificationVersion: 'v3' | 'v4'` literal), so the cast at the two `provider-factory.ts` call sites above is safe pending an upstream Mastra fix. Track this and revisit the cast when `@mastra/core` adds `EmbeddingModelV4` to its embedding union — `apps/desktop/src/assistant-server/mastra-memory.ts`'s `createLocalSemanticRecallEmbedder` already carries an equivalent pre-existing cast comment for the same reason (`EmbeddingModelV2` there), so both sites should be revisited together.
- `RuntimeProviderOptions` in `packages/agent/src/types.ts` (`SharedV2ProviderOptions | SharedV3ProviderOptions`) has no `SharedV4ProviderOptions` variant. This compiles clean today (no code path constructs V4-only provider option shapes yet) but is a forward-compatibility gap worth closing if a V4-only provider option shape is needed later.

**Not affected**

- `registry.ts` and `key-resolver.ts` have zero `@ai-sdk` imports.
- The four hand-implemented local/host-proxy model files (`local-language-model.ts`, `llm-host-chat-model.ts`, `local-message-conversion.ts`, `local-host-embedding-model.ts`) stay on `LanguageModelV2`/`EmbeddingModelV2`, still exported by `@ai-sdk/provider@4.x`.
- `packages/agent`'s dual ESM+CJS `tsup` build (`format:['esm','cjs']`, consumed by Electron main's CJS `require('@brainstrike/agent')`) still builds clean with the ESM-only `@ai-sdk/*@4.x` packages. **Correction:** these packages are NOT inlined into the CJS bundle — `@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai` are regular (non-external, non-bundled) `dependencies`, so `dist/index.js` (CJS) still emits `require("@ai-sdk/anthropic")` etc. at runtime (verified: `grep -c 'require("@ai-sdk' dist/index.js` → 3). What actually makes this work is Node's `require(esm)` interop (stable since Node 22.12), which both this package's and `@ai-sdk/provider`'s `engines.node: ">=22"` already assume, and which Electron 41 (bundled Node ~22.16) satisfies. Verified end-to-end from `apps/desktop`: `node -e "require('@brainstrike/agent').createProvider('anthropic', {apiKey:'x'})"` returns a real `LanguageModelV2`-shaped object (`specificationVersion`, `modelId`, etc.) through the actual CJS `require()` path exercised by `apps/desktop/src/ipc-agent.ts`'s `resolveAgentModule()`. Flagging because **no test in the repo exercises this path** — every `ipc-agent.test.ts` case injects `globalThis.__agentModule` directly, bypassing `require()` entirely, and the "LIVE loop" Mastra proof specs (`mastra-tool-execution.spec.ts` etc.) mock `provider-factory.ts`'s `createProvider`, so they never call the real `createAnthropic`/`createOpenAI`/`createGoogleGenerativeAI` (the alias used by that prior PR; renamed to canonical `createGoogle` by BST-1413) either. This was manually verified for this PR but is not covered by CI — worth a follow-up test that requires the built CJS `dist/index.js` directly instead of injecting `__agentModule`.

**Pointers**

- Mastra PR adding `LanguageModelV4`/AI SDK v7 support: [mastra-ai/mastra#18477](https://github.com/mastra-ai/mastra/pull/18477).

### `@mastra/core` 1.51.0 → ^1.57.0, `@mastra/memory` 1.22.1 → 1.26.0 — completed; BST-1097 approval flow re-based on the 1.56+ idiom

**Status:** `@mastra/core` `^1.57.0` and `@mastra/memory` `1.26.0` in `packages/agent` (the only manifest declaring them). Landed in two stages: 2026-08-06 held at `~1.55.0` below the 1.56 approval rework (`chore/deps-mastra-1.57`, PR #2295); 2026-08-07 the hold was lifted by ADAPTING the BST-1097 approval flow to the new idiom (`feat/mastra-approval-idioms`, user-directed).

**What 1.56 changed (bisect-proven; the reason the hold existed):** the approval-recovery rework makes the framework treat any resume of an approval-gated call as its own business — a bare `{approved: true}` is consumed and the tool re-runs with NO resume data, and `{approved: false}` becomes Mastra's minted denial without the tool running. The old BST-1097 design (tool raises Gate A itself via `suspend(…, {requireToolApproval: true})` and reads the answer) therefore looped forever on approve and lost the tool-owned declined result on decline.

**The adaptation (all repo-side, no framework workarounds):**

1. **Gate A → the framework's pre-execution approval.** The permission gate's `requireApproval` clone — the exact idiom every other ask tool already used — now covers run_python too; the self-approving exception and its registry (`SELF_APPROVING_NATIVE_TOOL_IDS`) are deleted. Same `tool-call-approval` chunk, card, grant surface, and approve/decline transport.
2. **Gate B stays a plain suspension, resumable under the flag via the `approved: true` rider.** 1.56+ re-checks `requireApproval` on every leg and converts a riderless resume into a denial; the suspend-resume transport (`createToolResumeIteratorFromRuntime`) attaches the rider for ask-registered tools, and run_python's resume schema admits it. This inverts the old "never combine the requireApproval flag with a suspendSchema" rule — the rider is precisely what makes the combination sound now.
3. **Decline is framework-owned and streams NO tool result** — matching the long-standing contract for every other declined ask tool (the approval card's "Declined" state owns the UX). run_python's typed `declined` result arm is legacy, kept for pre-rework persisted threads.
4. **Direct invocations stay guarded in-tool**: `'ask'` with no suspension channel refuses (`approval_confirmation_unavailable`); a bare `{approved}` resume reaching the tool is schema-rejected loudly (drifted shape, never a silent run).

**Verification:** `mastra-tool-suspend-resume.integration.spec.ts` 15/15 at 1.57.0 (the two former Gate A canaries now pin the NEW contract: approve → Gate B → allow executes the script; decline streams no tool event and never touches the executor), agent 1629 unit + 293 integration, permission-gate/approval-chunks/run-python unit suites re-pinned to the new mechanism, `suspending-tool-registry-contract` guard updated. Contract docs updated in the same change: code-execution.md (Gate A section), assistant-runtime.md (permission engine step 2/4), mastra-boundary.md.

**Breaking changes in 1.52–1.55 that did NOT apply here:** Channels reaction tools no longer auto-injected (1.53), `ChannelHandler` `ctx` param (1.54), Braintrust exporter config (SDK v2→v3, 1.52), AgentController canonical `MastraDBMessage` shape (1.52) — none of these surfaces are used by this repo.

**Compile-time changes hit and fixed (both land by 1.55):**

1. **`ToolExecutionContext.observe` became required** (tool-observability helpers) while `createTool`'s execute callback context is statically only `{ requestContext }`. `packages/agent/src/mastra/mcp-runtime-client.ts` now types its inbound context as a `McpExecuteContext = Pick<ToolExecutionContext, 'agent' | 'writer' | 'abortSignal'> & { requestContext?: unknown }` slice.
2. **`ToolsInput[string]` widened** with execute-less members (provider-defined tools, web-search placeholders): `.execute` probes must `'execute' in tool`-narrow first — fixed in `apps/desktop/src/ipc-tools.ts` (`tryExecuteAssistantRuntimeTool`) and `capture-on-edit.integration.test.ts` (new `executeTool` helper that throws on a non-executable tool).

**Behavioral notes verified:**

- **`EmbeddingModelV4` still absent** from `MastraEmbeddingModel` (verified in installed types at both 1.55 and 1.57) — the documented casts in `provider-factory.ts` stay.
- The `@ai-sdk/ui-utils` `zod@^3` unmet-peer warning disappeared at 1.55 (Mastra dropped that chain); only the pre-existing `@codecov/vite-plugin` vite-range warning remains workspace-wide.
- Deferred by the hold (ships in 1.56/1.57): approval refresh-recovery, parallel-approval persistence, the suspended-run warm-state TTL (`MASTRA_SUSPENDED_RUN_TTL_MS`, 30 min default, durable-snapshot fallback), transient signals, `processToolResult` hook.

**Validation:** boundary guard `scripts/__tests__/mastra-boundary-contract.test.mjs` 6/6; `lint:mastra-stream-chunk-contract` + `lint:mastra-schema-init-order` clean; agent 1629 unit + 293 integration (all 15 suspend-resume tests), assistant-service 59, desktop 2341 unit + 852 integration (real-PGlite capture-on-edit suite included), workspace type-check green. `docs/agents/mastra-boundary.md` re-verified and updated in the same change.

**Pointers**

- [@mastra/core CHANGELOG](https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md), [@mastra/memory CHANGELOG](https://github.com/mastra-ai/mastra/blob/main/packages/memory/CHANGELOG.md).
- Upstream agent-approval docs (current sanctioned patterns): [Agent approval](https://mastra.ai/docs/agents/agent-approval).

---

## web-tree-sitter (`web-tree-sitter` 0.25.x → 0.26.x) — deferred

**Why it matters:** `packages/chunking-worker/src/parsers/tree-sitter-adapter.ts` and
`tree-sitter-grammar-loader.ts` use `web-tree-sitter` to parse Python for
structure-aware chunking (function/class/decorated-definition boundaries),
falling back to a recursive/line-based chunker when the grammar can't load.

**What broke:** The vendored grammar WASM
(`packages/chunking-worker/grammars/python.wasm`) used to be sourced from
`tree-sitter-wasms@0.1.13` — abandoned, last published 2025-10-07, still the
latest release of that package — and used the legacy Emscripten `"dylink"`
WASM custom-section name. `web-tree-sitter@0.26.10`'s bundled runtime dropped
the fallback that 0.25.x had for that legacy name and only accepts
`"dylink.0"`. Verified live: loading the exact vendored `.wasm` bytes via
`Language.load()` succeeded on 0.25.10 and threw immediately on 0.26.10
(a bare `Error` with an empty message, from `getDylinkMetadata` → `failIf`).
All other API surface this repo actually calls
(`Parser.init/setLanguage/parse`, `Language.load`, `Query`, `query.matches`,
`Node.type/startIndex/endIndex`, `tree/parser.delete`) is unchanged between
the two versions.

Per the existing catch-and-evict code in `tree-sitter-grammar-loader.ts`,
this failure doesn't crash the app — it falls back to the recursive chunker —
but it silently defeats the whole point of the tree-sitter-based Python
chunking feature, so it must not ship unremediated.

**Grammar side: resolved (BST-1277).** `grammars/python.wasm` is now
`tree-sitter-python@0.25.0`'s package-root `tree-sitter-python.wasm`
(`dylink.0`, ABI 15) — the canonical `tree-sitter/tree-sitter-python` repo.
`@vscode/tree-sitter-wasm@0.3.1` ships a byte-identical copy of the same
artifact, so the choice was provenance, not content. The bytes are vendored
rather than taken as a dependency: nothing imports the package, and
`tree-sitter-python` carries an `install: node-gyp-build` script plus
five-platform native prebuilds that the vendored-`.wasm` architecture never
uses. `tree-sitter-wasms` is gone from the tree.
`src/__tests__/tree-sitter-grammar-abi.test.ts` pins the artifact's sha256,
asserts the `dylink.0` section name, and asserts ABI >= 15 — the pin is
enforced now instead of documented.

**What remains before unpinning `web-tree-sitter`**

- Bump `packages/chunking-worker`'s `web-tree-sitter` range to `^0.26.x` and
  re-run the chunking-worker suite plus
  `apps/desktop/e2e/chunking-host-renderer.test.ts` (its chunk-count
  assertions discriminate tree-sitter output from the recursive fallback, so
  a silent degrade shows up as a failure rather than a quality regression).
- Re-check the rest of the 0.26 API surface against the call sites listed
  above; only the `dylink` fallback removal was investigated in depth.

**Pointers**

- [`Gregoor/tree-sitter-wasms#52`](https://github.com/Gregoor/tree-sitter-wasms/pull/52) (closed, unmerged; documents the `dylink` → `dylink.0` format change)
- [`tree-sitter/tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python) — canonical grammar; the npm package ships the prebuilt `dylink.0` WASM at its package root

---

## Deferred or pinned dependencies

Tracked decisions where we intentionally hold a dependency below its latest version, with the issue that owns the unpin.

| Package | Pinned at | Reason | Tracking |
| --- | --- | --- | --- |
| `web-tree-sitter` | `^0.25.10` | Blocker cleared on the grammar side by BST-1277: the vendored Python grammar is now `tree-sitter-python@0.25.0` (`dylink.0`, ABI 15), which 0.26.10 loads. What remains is the range bump itself plus a re-check of the rest of the 0.26 API surface. | (covered in web-tree-sitter section above) |
| `@swc/core` + `@swc/wasm` | `~1.15.47` / `~1.15.43` | Not our bug: `vite-plugin-top-level-await@1.6.0` builds SWC AST nodes in JS, and swc 1.16.0's Rust-side AST change makes them fail to deserialize. Blocks the **web and desktop** builds (`topLevelAwait()` is used by both). Held by two subtree-scoped `overrides:` — the load-bearing pin — plus a narrowed catalog entry for single-resolution hygiene. **Both** swc packages must stay pinned: the plugin picks between them at `require()` time, so pinning only the native half leaves the wasm fallback free to drift. Unpin when the plugin ships a swc ≥ 1.16-compatible release (1.6.0 is latest as of 2026-08-15 and is not); `scripts/__tests__/swc-ast-break-block.test.mjs` fails until the overrides, the catalog range, and the guard are all retired together. | [BST-1311](https://linear.app/brainstrike/issue/BST-1311) |

**Resolved:** `react-helmet-async` was pinned at `^2.0.5` because 3.0.0's `React19Dispatcher` stopped deduping `<title>`/`<meta>` across simultaneously-mounted instances. Rather than unpin, the dependency was **removed** 2026-08-15 (BST-1281) in favour of a single-writer `useDocumentTitle` hook — see the react-helmet-async section above.

**Resolved:** `typescript` was pinned at `^5.9.3` pending a coordinated TS 6 migration (`FileSystemDirectoryHandle` mocks in `packages/utils`). Unpinned to `^6.0.3` 2026-07-06 in `chore/deps-typescript-6` — see the TypeScript section above for the full list of breaking changes hit and fixed (five in total: `baseUrl` deprecation, a tsup upstream bug, the originally-documented mock issue, stricter composite-project `rootDir` enforcement surfacing pre-existing `src`-vs-`dist` path mapping bugs, and `noUncheckedSideEffectImports`).

> When unpinning, follow the acceptance criteria in the linked Linear issue (or the section above), regenerate `dependency-version-updates-report.md`, and run the full `pnpm check:full` pipeline before merging.

---

## What this document does *not* cover

- **Transitive dependencies:** `pnpm outdated -r` focuses on direct dependencies. Majors inside nested packages may still require `pnpm why <pkg>` investigations.
- **Exact CI commands:** Prefer your existing `AGENTS.md` / internal docs for full validation steps.
- **Security advisories:** Cross-reference `pnpm audit` / GitHub Dependabot separately from version freshness.

---

## Regenerating both reports

```bash
pnpm install
node scripts/generate-dependency-update-report.mjs
# Revisit this file and update version numbers / notes when dependencies change materially.
```

Edit the breaking-changes narrative manually after regeneration: automated tools can list versions, but **migration work** should be confirmed against the official changelog links above.
