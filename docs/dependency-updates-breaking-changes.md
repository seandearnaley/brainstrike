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
| `knip` | 5.88.1 | 6.16.1 | Unused-code analysis, JSON reporters, Node engine |
| `@codecov/vite-plugin` | 1.9.1 | 2.0.1 | Vite build + Codecov upload wiring |
| `react-helmet-async` | 2.0.5 | 3.0.0 | SSR helmet types / peer range (React 19) |
| `@commitlint/cli` | 20.5.0 | 21.0.2 | Git hook / CI commit-message validation |
| `@commitlint/config-conventional` | 20.5.0 | 21.0.2 | Conventional commit rule defaults |
| `@commitlint/types` | 20.5.0 | 21.0.1 | Commitlint TypeScript API consumers |
| `concurrently` | 9.2.1 | 10.0.3 | Local script orchestration |
| `syncpack` | 14.3.0 | 15.3.1 | Dependency lint/fix commands and config schema |

---

## TypeScript (`typescript` 5.x → 6.x)

**Why it matters:** Major compiler releases can change defaults, diagnostics, and editor behavior even when application source looks unchanged.

**What to verify**

- Read the official **TypeScript 6.0** release notes end-to-end before bumping the workspace-wide `typescript` version.
- Expect possible changes around **default `tsconfig` behavior**, stricter defaults, and deprecations of legacy module resolution targets. Treat this as a **repo-wide** migration: align `typescript`, `@types/*`, ESLint typescript-eslint, Vitest, and IDE tooling.
- Use `--stableTypeOrdering` (or equivalent flags mentioned in the release notes) if you need deterministic ordering while migrating large codebases.

**Pointers**

- Start with the handbook release notes for the target line: [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).
- Cross-check the high-level announcement: [Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/).

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

## Knip (`knip` 5.x → 6.x)

**Why it matters:** Knip 6 switches parsing/resolver internals and tightens CLI compatibility.

**What to verify**

- **Node.js:** Knip 6 requires a **newer Node** baseline (v20.19+ per upstream v6 announcement—confirm in the blog post for the exact floor).
- **CLI flags removed/renamed:** Flags like `--include-libs` / `--isolate-workspaces` may be obsolete because behavior is now default; update CI invocations.
- **JSON reporter shape:** Issues are normalized to arrays; remove reliance on removed fields such as `issues._files` / root `files` if you parse JSON output.

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

## react-helmet-async (`react-helmet-async` 2.x → 3.x)

**Why it matters:** Mostly type/API cleanup and React 19–oriented peer dependency alignment.

**What to verify**

- If you use advanced SSR types, note removals/changes around server state helpers (`HelmetServerState.titleAttributes`, `MappedServerState` export).
- `HelmetDatum.toComponent()` typing now reflects array elements—adjust any custom wrappers.

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

## Assistant UI styles (`@assistant-ui/styles`, deprecated)

**Why it matters:** Deprecated packages may stop receiving fixes; builds stay on an old design-token surface.

**What to verify**

- Identify the replacement package or styling approach recommended by Assistant UI for your stack (web/desktop), then migrate imports and CSS variables accordingly.

**Pointers**

- Assistant UI docs / repo (search for “styles” deprecation in the org you import from).

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

---

## Deferred or pinned dependencies

Tracked decisions where we intentionally hold a dependency below its latest version, with the issue that owns the unpin.

| Package | Pinned at | Reason | Tracking |
| --- | --- | --- | --- |
| `typescript` | `^5.9.3` | 6.0.x stricter DOM types break `FileSystemDirectoryHandle` test mocks in `packages/utils`. Needs a coordinated TS 6 migration across the workspace. | (covered in TypeScript section above) |
| `react-helmet-async` | `^2.0.5` | 3.x adds an `exports` field that breaks vite's resolution of `react-fast-compare` under `preserveSymlinks: true`. | (covered in react-helmet-async section above) |

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
