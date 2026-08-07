# BST-981 assistant-ui package extraction report

## Outcome

The extraction is implemented. `packages/ui/src/assistant-ui-panel` no longer
exists, the assistant feature now lives in the new private
`@brainstrike/assistant-ui` workspace package, all source consumers use the new
package, and the lockfile/build graph are updated.

Three exact verification commands cannot be green in this execution sandbox:
the aggregate unit gate has three web tests that open a real loopback listener,
the assistant browser project needs Vitest to open a loopback listener, and the
aggregate lint command asks Biome to read sandbox-protected `.agents/skills`
files. The failures and successful isolation checks are recorded below. No
commit or push was performed.

## What moved and was renamed

- The repository contained 161 tracked files under
  `packages/ui/src/assistant-ui-panel`, not the spec's estimated 159.
- One of those files, `tooltip-icon-button.tsx`, was hoisted to
  `packages/ui/src/tooltip-icon-button.tsx` because it is a generic shared UI
  primitive. Its test remains in UI and was updated to import the hoisted file.
- The other 160 panel files were moved to `packages/assistant-ui/src`, with the
  old directory contents becoming the new source root. `overrides.css` moved to
  `packages/assistant-ui/src/overrides.css` and is copied by the new package's
  build.
- 41 root-level UI tests whose non-test imports target the moved feature were
  moved into `packages/assistant-ui/src/__tests__`. Together with the 57 tests
  already nested under the panel, the new package has 98 test files, including
  seven browser test files.
- The completed assistant source tree has 203 files: 160 panel files, 41 moved
  root tests, `vite-env.d.ts`, and the new RED/GREEN package export contract
  test.
- Three root tests collided with same-named nested tests and were renamed
  mechanically:
  - `assistant-run-timeline.test.tsx` ->
    `assistant-run-timeline-panel.test.tsx`
  - `assistant-tool-approval-notice.test.tsx` ->
    `assistant-tool-approval-notice-panel.test.tsx`
  - `tool-fallback.test.tsx` -> `tool-fallback-panel.test.tsx`
- `@brainstrike/assistant-ui` exposes `.`, `./context-usage-store`,
  `./follow-up-queue-store`, and `./rewind-composer-store`. Existing external
  imports were rewritten to those paths.
- Direct source consumers were found only in `@brainstrike/app-shell`; no
  direct old panel imports existed in agent, web, or desktop source. Web and
  desktop still received project/build references because they consume the
  app-shell graph and the spec explicitly requires full-graph wiring.

The moves were executed with `git mv` through a temporary alternate Git index.
The managed sandbox grants read-only access to the worktree's real `.git`
index, so the final real-index status presents the changes as deletions plus
untracked additions. Staging in a normal checkout will detect the moves; the
working-tree file contents are the result of the `git mv` operations.

## UI dependency and barrel audit

The following runtime dependencies were removed from `packages/ui/package.json`
after repository-wide import searches showed no remaining UI source use:

- `@assistant-ui/react`
- `@assistant-ui/react-markdown`
- `@assistant-ui/styles`
- `@brainstrike/assistant-contract`
- `@brainstrike/assistant-wire`
- `@brainstrike/tokenization`
- `assistant-stream`
- `zustand`

The assistant-owned dependencies are declared by the new package. UI retains
`@tanstack/react-virtual` for TreeTable, and retains the React/Shiki, markdown,
KaTeX, Mermaid, YAML, rehype, and remark dependencies used by its shared code
block and markdown-surface implementations.

Barrel/export changes:

- Added `TooltipIconButton` to the `@brainstrike/ui` root barrel; the new
  assistant root re-exports it to preserve the old assistant panel API.
- Added the existing provider-color helpers to the UI model-picker barrel for
  the moved composer model menu.
- Added `@brainstrike/ui/code-block` as an explicit UI package subpath for the
  moved markdown adapters. See the documented deviation below.

## Configuration touchpoints edited

Package/workspace graph and lockfile:

- `packages/assistant-ui/package.json` (new package metadata, dependencies,
  scripts, four exports)
- `packages/assistant-ui/tsconfig.json` (new build project and references)
- `packages/assistant-ui/tsconfig.test.json` (new test type-check project)
- `packages/assistant-ui/vitest.config.mts` (unit/browser projects and aliases)
- `packages/ui/package.json` (remove assistant exports/dependencies/copy step;
  add code-block subpath)
- `packages/ui/tsconfig.json` (remove now-unused assistant references)
- `packages/app-shell/package.json` and `packages/app-shell/tsconfig.json` (new
  dependency/reference)
- `apps/web/tsconfig.json` and `apps/desktop/tsconfig.json` (new graph
  references)
- `tsconfig.json` (root aliases and project reference)
- `pnpm-lock.yaml` (52-workspace lockfile update)

Build, test, lint, and analysis configuration:

- `packages/app-shell/vitest.config.mts` (new package/subpath source aliases;
  anchored root alias)
- `apps/web/vitest.config.mts` (assistant-ui optimize dependency)
- `packages/ui/vitest.config.mts` (remove obsolete assistant alias; make the
  intentionally empty post-move browser project pass with no tests)
- `apps/web/vite.config.mts` and `apps/desktop/vite.config.mts` (assistant-ui
  optimize dependencies)
- `apps/web/package.json` was inspected; it has no prebuild filter chain to
  change. `apps/desktop/package.json` gained assistant-ui in `prebuild`.
- `packages/ui/styles.css` (Tailwind v4 `@source` for assistant-ui)
- `packages/build-utils/src/vite.ts` and
  `packages/build-utils/src/__tests__/vite.test.ts` (lazy-surface source pins)
- `architecture/domain-map.json` (foundation-domain package registration)
- `knip.jsonc` (assistant-ui workspace project and justified test/config-only
  dependency ignores)
- `biome.json` (moved-file exception paths)
- `eslint.config.js` and root `package.json` (assistant-ui lint scope)
- `scripts/enforce-coverage.mjs` (recalibrated UI floor)
- `turbo.jsonc` (assistant-ui development dependency)

CI and coverage configuration:

- `.github/workflows/test.yml` (browser filter, comments, artifacts)
- `.github/workflows/nightly-coverage.yml` (assistant-ui coverage filter and
  complementary exclusion)
- `codecov.yml` (`pkg-assistant-ui` component)

Documentation/source-adjacent touchpoints:

- `packages/assistant-ui/README.md` (new ownership summary)
- `packages/ui/AGENTS.md` and `packages/ui/README.md` (feature moved)
- `packages/app-shell/README.md` (new import paths)
- `docs/agents/assistant-runtime.md`
- `docs/agents/assistant-persistence.md`
- `docs/agents/assistant-providers.md`
- `docs/agents/local-inference.md`
- `docs/agents/platform-contracts.md`
- `docs/agents/workspace-context.md`
- `packages/types/src/assistant-provider-settings.ts` and
  `packages/db/__tests__/mastra-om-schema-projection.test.ts` (live source/test
  path comments)

`docs/agents/changeset-diff.md` and the assistant E2E files were inspected and
contained no relevant moved-module import/path to change.

## RED gate

**PASS (expected failure observed).** After scaffolding the empty package, the
contract command exited 1 before collecting tests because the shared alias
registry could not resolve the absent source entry:

```text
workspaceSrcAliases: @brainstrike/assistant-ui export '.' has no source file
for stem 'index' under .../packages/assistant-ui/src
```

The now-green contract asserts the exact four manifest export subpaths and the
existence of `src/index.ts`.

## Install and GREEN verification gates

| Gate | Outcome | Relevant real output |
| --- | --- | --- |
| `pnpm install` / final offline frozen replay | **PASS** | `Scope: all 52 workspace projects`; `Already up to date`; exit 0. The environment had no registry access, so installation used pnpm 11's offline store plus `--trust-lockfile`; the final `--frozen-lockfile` replay passed. |
| Exact Turbo unit command from the spec | **ENVIRONMENT-BLOCKED (exit 1)** | Web: `Test Files 1 failed \| 33 passed`; `Tests 3 failed \| 389 passed`; each failure is `listen EPERM: operation not permitted 127.0.0.1`. No refactor assertion failed. |
| Supplemental Turbo unit run excluding only web | **PASS** | `Tasks: 6 successful, 6 total`; assistant-ui 91 files/851 tests, UI 121 files/1,258 passed + 3 skipped, app-shell 155/1,733, agent 107/1,628 + 1 skipped, desktop 223/2,341, build-utils 5/56. |
| Exact Turbo type-check command | **PASS** | `Tasks: 52 successful, 52 total`; exit 0. |
| Exact web + desktop Turbo build command | **PASS** | `Tasks: 47 successful, 47 total`; web `built in 47.34s`; chunk-cycle check passed. Existing PGlite `eval` and ineffective-dynamic-import warnings remained. |
| `pnpm run test:scripts` | **PASS** | `tests 840`; `pass 840`; `fail 0`; exit 0. Because the real Git index is sandbox-read-only, this used an ignored local Git wrapper that exposes the intended post-move tracked topology to repository contract tests. An ignored Node preload also substitutes sandbox-denied uptime/`ps` probes; neither helper is a source change. |
| `pnpm run lint` | **ENVIRONMENT-BLOCKED (exit 1)** | All guard/architecture stages and ESLint ran; final Biome scan reported 14 `internalError/io` failures reading sandbox-protected `.agents/skills/*` (`Operation not permitted`). `pnpm run lint:eslint` independently passed with `0 errors, 193 warnings`, below the 194-warning cap. |
| `pnpm run knip` | **PASS against baseline; command retains baseline exit 1** | Baseline actionable counts: files 12, deps 13, devDeps 64, unlisted deps 2, binaries 13. Final: files 12, deps 11, devDeps 10, unlisted deps 2, binaries 2. No new actionable finding exists. Advisory configuration hints changed from 149 to 156; Knip does not treat them as issue findings, and none names `packages/assistant-ui`. |
| `pnpm --filter @brainstrike/assistant-ui test:browser` | **ENVIRONMENT-BLOCKED (exit 1)** | Vitest could not start its browser server: `listen EPERM: operation not permitted ::1`; no test file ran. Chromium tooling is installed, so this was attempted rather than skipped. |
| `pnpm --filter @brainstrike/ui test:browser` | **PASS** | All UI browser specs moved to assistant-ui; output is `No test files found, exiting with code 0` after explicitly configuring the retained CI-synchronized project for this state. |
| Assistant-ui coverage | **PASS** | 91/91 files and 851/851 tests; statements 90.49% (4112/4544), branches 82.97% (3183/3836), functions 92.18% (991/1075), lines 90.39% (3973/4395). All exceed defaults, so no assistant-ui override was added. |
| UI coverage | **PASS** | 121/121 files; 1,258 passed + 3 skipped; statements 93.33% (3978/4262), branches 84.94% (2792/3287), functions 94.86% (887/935), lines 93.27% (3910/4192). UI floor recalibrated with a small margin to B83/F93/L92/S92 and the required BST-981 comment. |
| Final structural checks | **PASS** | Old panel directory absent; no old path/import remains in source, config, or the requested `docs/agents` files; `git diff --check` exits 0. |

## Deviations and why

1. **Actual counts differ from estimates.** The tracked panel directory had
   161 files and the import-based root test audit selected 41 files. The report
   uses those verified counts rather than the spec's approximate 159/44.
2. **Code block is a UI subpath, not a root-barrel export.** The existing
   `packages/ui/src/code-block/index.ts` explicitly says not to export it from
   the main barrel so React Shiki stays out of the always-mounted chunk. A first
   root-barrel implementation caused real web test startup failures through
   React Shiki's CSS side effect. `@brainstrike/ui/code-block` preserves the
   established lazy boundary while still making the shared primitive available
   to assistant-ui. The focused web settings suites passed 7/7 after this
   correction.
3. **UI's retained browser command is explicitly no-test-green.** All seven
   assistant browser specs moved, leaving UI with no matching browser files.
   `passWithNoTests` keeps the CI filter/script contract valid without inventing
   a non-assistant browser test.
4. **Offline/sandbox accommodations.** Registry access, writes to the real Git
   index, local socket listeners, `.agents/skills` reads from Biome, `os.uptime`,
   and `/bin/ps` are restricted here. Offline pnpm flags and ignored local
   verification helpers were used where behavior could be reproduced safely;
   socket/browser and Biome I/O failures are reported rather than hidden.
5. **Historical documentation remains untouched.** Repository-wide grep still
   finds old paths in dated architecture/design reports and historical update
   ledgers outside `docs/agents`; the spec explicitly excludes those records.

## Blocked or incomplete

- The code/configuration work is complete.
- The exact aggregate unit command remains red only because three existing web
  tests require a real loopback listener prohibited by the sandbox. All six
  other requested package test tasks pass together.
- The assistant-ui browser command remains red only because Vitest cannot bind
  its loopback server in the sandbox.
- The exact aggregate lint command remains red only at Biome's scan of
  sandbox-protected `.agents/skills`; ESLint and all preceding lint/architecture
  guards pass.
- These three commands should be replayed in an unrestricted local/CI
  environment. No source fix within the requested refactor can grant those OS
  permissions.

No other work is blocked or incomplete.
