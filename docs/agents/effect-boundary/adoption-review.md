# Effect adoption review — evidence

Supports `docs/agents/effect-boundary.md` § "Version pins", and the Promise
boundary and diagnostics rules beside it. The record behind ADR-0004: what was
measured on 2026-09-24, before the first Effect code landed.

## Release state on 2026-09-24

- npm dist-tags for `effect`: `latest` 3.22.2 (2026-09-09), `rc` 4.0.0-rc.117
  (2026-09-21T04:54Z), `beta` frozen at 4.0.0-beta.107.
- The 4.0 release-candidate post (effect.website/blog/releases/effect/40-rc,
  2026-08-12) says no more broad breaking changes are planned and targets a
  stable release in Q3/Q4 2026. The v4 source moved into `Effect-TS/effect`
  `main`; `Effect-TS/effect-smol` is archived.
- After rc.117, `main` moved every `effect/unstable/*` module to a top-level
  path with no aliases (Effect-TS/effect#8354, #8365, 2026-09-22). That is why
  the contract forbids `effect/unstable/*` imports and pins an exact version.
- v3 was rejected for this repo: `@effect/vitest` 0.30.0 peers on Vitest ^3.2
  (we run Vitest 5), `@effect/sql-pglite` exists only for v4, and the TypeScript
  7 language service (`@effect/tsgo`) targets v4 first.

## Bundle cost

Minified, gzip -9, Rollup unless noted:

| Program | v3.22.2 | v4 rc.117 | v4, Rolldown (Vite 8) |
| --- | --- | --- | --- |
| `Effect.runFork(Effect.succeed(1))` | 35.2 KB | 6.9 KB | 7.1 KB |
| gen + sleep + runPromise | 35.7 KB | 9.3 KB | 9.6 KB |
| plus a Schema struct decode | 46.7 KB | 18.7 KB | 21.9 KB |
| Layer + ManagedRuntime + retry + timeout + catchTag | 42.5 KB | 14.7 KB | 15.1 KB |

- v4 publishes only the `effect` barrel, `effect/testing`, and
  `effect/unstable/*`; there are no per-module deep imports. esbuild tree-shakes
  the barrel poorly: the minimal v4 program measured 29 KB with esbuild. The
  apps bundle with Vite 8, so this matters only for the tsup bundles.
- Schema parsing is interpreted by default. The JIT compiler is opt-in
  (`SchemaJITCompiler.enable`) and falls back when `new Function` is blocked,
  so Effect Schema needs no CSP switch, unlike zod's `jitless` in
  `apps/web/src/entry.ts`.

## Runner behaviour that shaped `runAtPromiseBoundary`

Measured against rc.117 on Node:

- `Effect.runPromise` rejects with the failure value itself (a
  `Data.TaggedError` instance keeps its class) and with the thrown value for a
  defect. v3 wrapped both in a `FiberFailure`.
- Aborting the `signal` passed to `runPromise` rejects with a generic
  `Error("All fibers interrupted without error")`, not `signal.reason`, so
  existing `isAbortError` checks would stop matching.
- With an already-aborted `signal`, `runPromiseExit(Effect.sync(...))` still
  runs the synchronous body and returns `Success`. The helper therefore calls
  `signal.throwIfAborted()` before starting.
- `Effect.timeout` interrupts the fiber, which aborts the `AbortSignal` that
  `Effect.tryPromise` hands to `try`: the work stops, not only the wait.

## Language service

- `@effect/tsgo` 0.45.0 supports TypeScript 7.0.2. `effect-tsgo patch` tries the
  `typescript` package first, which resolves to TypeScript 6 in this catalog,
  and patching would rewrite the shared compiler; dedicated
  `effect-tsgo diagnostics --project` mode needs neither.
- Diagnostics mode reads the `@effect/language-service` tsconfig plugin entry;
  without it the command checks 0 files and passes vacuously. With it, a planted
  `Effect.log(...)` statement failed with `effect(floatingEffect)` and exit 1 in
  about a second; a clean project exits 0.
