# App test-tsconfig programs — evidence

Supports `docs/agents/ci-quality.md` § "App test-tsconfig programs
(`tsconfig.test.json`)". Read this before changing either app's
`tsconfig.test.json`, the desktop `type-check:test` verifier, or its floor. The
contract holds the rules; this file is the record of why.

`apps/web` and `apps/desktop` type-check their test files through a dedicated
`tsconfig.test.json` in the `type-check` chain. Both set `"paths": {}` so
workspace deps resolve to built `dist` declarations (each produced under its
own package's tsconfig) instead of recompiling foreign sources under the app's
ambient shims. Two consequences to keep in mind:

- `type-check:test` needs deps built first. Turbo's `type-check` task
  (`dependsOn: ["build"]`) covers CI and `pnpm type-check`; a bare
  `pnpm --filter <app> type-check` in a fresh clone will not have `dist/`.
- The app's production `src` files reached from tests are checked TWICE under
  two different resolution graphs (src-paths in the main program, dist in the
  test program), so `type-check:main` passing does not imply `type-check:test`
  passes on the same file. Desktop additionally excludes its renderer-only
  PGlite shims (`src/types/pglite*.d.ts`) from the test program — an ambient
  `declare module` would otherwise shadow the real `@electric-sql/pglite`
  types for everything the tests pull in. Desktop's test program also sets
  `declaration: false` (corrected 2026-09-21: web's does not; it sets
  `noEmit: true` and inherits `declaration: true`): a `noEmit` program never emits d.ts, and inheriting
  `declaration: true` makes exported `vi.fn()` mocks fail TS2883 portability
  checks that vary with pnpm store layout.

Desktop's `type-check:test` runs `scripts/verify-test-tsconfig-program.mjs`
instead of invoking `tsc` directly. The wrapper asks the pinned compiler for
the actual program through `--listFilesOnly`, requires at least 400 desktop
test roots, and then runs the unchanged `tsc --noEmit` diagnostic pass. The
floor is an anti-vacuity contract: `tsconfig.test.json` selected 419
test files when the floor was set (526 files match its `*.test.ts(x)` globs as
of 2026-09-21), and an inherited/excluded test glob must fail before a zero-file
type-check can look green again. Its script tests include an empty-root
control, a broken test-only import that must surface TS2307, and manifest/cache
wiring assertions. `scripts/ts7-parity-check.mjs` unwraps the verifier command
back to its `--project` so the desktop test program remains in TS6↔TS7 parity
coverage. Because the verifier lives outside `apps/desktop`,
`apps/desktop/turbo.json` explicitly includes it in the desktop `type-check`
task inputs alongside `$TURBO_DEFAULT$`; changing the anti-vacuity or
diagnostic logic must invalidate Turbo's cached result.
