# Chunk-cycle invariant: a complete guard for the module-scope init-order class

> BST-861. Design approved 2026-07-25. Supersedes the approach written into the
> ticket itself — see "Why the ticket was wrong".

## Problem

A module-scope initializer that READS an imported binding runs at bundle **chunk
initialization**. Bundle chunk order does not guarantee the exporting chunk has
evaluated, so the binding can be `undefined` in the built renderer. Nothing in
the normal toolchain sees this: `tsc` types ESM live bindings identically either
way, there is no lint rule for chunk-evaluation order, and Vitest evaluates real
modules in dependency order so unit tests always observe a defined binding. Only
a production build has a chunk graph, so only E2E observes it — as an
unexplained startup failure with no pointer to the cause.

The trigger is an import *edge*, not a code change. "My diff doesn't touch that
file" is not a defence.

### The class has four recorded scars, not two

| # | Symptom | Mitigation in place |
| --- | --- | --- |
| #1292 | `defineContextAction` TDZ; `#root` stays empty | `context-action-system` chunk pin |
| BST-580 | `L is not a function`; blank startup shell | `browser-events` chunk pin |
| — | `createWithEqualityFn is not a function`; blank shell | `zustand` chunk pin |
| BST-558 / #1988 | `Cannot read properties of undefined (reading 'threads')` | lazified reads + family AST guard |

Three of the four are held by `codeSplitting.groups` entries in **both**
`apps/web/vite.config.mts` and `apps/desktop/vite.config.mts`. Every one was
found by a production failure after the fact. Nothing detects a *new* instance.

## Why the ticket was wrong

BST-861 assumed the answer was a cleverer AST heuristic, and warned that a naive
"flag every module-scope read of an imported binding" rule returns 431 hits in
`app-shell` + `db` alone, nearly all benign.

That framing is beaten by a measurement: **a cross-chunk cycle is not a proxy
for this hazard, it is the necessary precondition.** ESM evaluates a module's
dependencies before its own body, so with an acyclic chunk graph a topological
init order always exists and every imported binding is initialized before any
module-scope read of it. A cycle is the only way to get an uninitialized binding
at module scope.

Measured on `657cd3538`:

| Bundle | Chunks | Static cross-chunk edges | Cyclic SCCs |
| --- | ---: | ---: | ---: |
| `apps/web/dist/assets` | 362 | 1003 | **0** |
| `apps/desktop/dist/renderer/assets` | 367 | 1036 | **0** |

The invariant is therefore true *today*, which makes it enforceable now rather
than aspirational.

## The invariant

> In both built renderer bundles, the static chunk import graph must be acyclic.

Properties this buys, which no AST rule can:

- **Complete for the class.** Zero cycles ⇒ no instance can fire, regardless of
  how many module-scope reads exist. Covers all four families above and every
  future one.
- **No allowlist, no registration.** Nothing to remember when adding a family —
  the 431-hit noise floor never arises, because source code is never inspected.
- **Zero false positives by construction.** It reports on emitted artifacts, so
  it cannot mislabel correct source.

## Component design

### `scripts/verify-no-cross-chunk-cycles.mjs`

Single responsibility: given a directory of emitted chunks, report cycles.

1. Read every `*.js` in the given directory.
2. Build a chunk→chunk graph from **static** edges only:
   - `import … from '…'` and bare `import '…'`
   - `export … from '…'` / `export * from '…'`
   - **`import()` is deliberately excluded.** Dynamic imports do not participate
     in init ordering; counting them would invent cycles that cannot fire.
   - Relative specifiers resolving to a sibling emitted chunk only; bare/external
     specifiers are ignored.
3. Tarjan SCC. Any component of size > 1, or a self-edge, is a violation.
4. Exit non-zero listing each cycle's members.

Exported for tests: `buildChunkGraph`, `findChunkCycles`, and `main`.

### Honesty properties (BST-836)

An instrument that cannot fail is not evidence. Two floors, both throwing rather
than returning "clean":

- **Chunk floor** — fewer than 50 discovered chunks means the directory is wrong
  or unbuilt.
- **Edge floor** — fewer than 100 parsed static edges means the import regex has
  stopped matching the bundler's output format. Without this, a rolldown output
  change would silently turn the guard into a permanent green.

Real values are ~362/1003 and ~367/1036, so both floors carry wide headroom
while still catching a broken instrument. The floors apply only to the
real-bundle entry point; the pure graph/SCC functions are floor-free so tests can
drive them over small fixtures.

`main` plus the `process.argv[1]` direct-execution idiom means
`scripts/__tests__/verify-script-entrypoints.test.mjs` discovers it
automatically, including that test's MONEY TEST (must refuse to report success
on a root it cannot verify).

### Wiring

Appended to each app's renderer build, mirroring the existing build-artifact
guard precedent (`verify-tokenizer-asset-bundle.mjs`, run inside
`chunking-worker` and `token-cache` build scripts):

```
apps/web       build:           vite build && node ../../scripts/verify-no-cross-chunk-cycles.mjs dist/assets
apps/desktop   build:renderer:  … && node ../../scripts/verify-no-cross-chunk-cycles.mjs dist/renderer/assets
```

Running inside `build` rather than as a CI step is deliberate: the check then
runs in the Build job, in both E2E jobs (which build first), and locally, with no
CI-only wiring that can drift. A turbo cache hit skips it, which is correct —
identical inputs produce an identical artifact and therefore an identical
verdict, the same tradeoff the tokenizer guard already accepts.

### Failure output

Actionable, because "chunks X and Y form a cycle" alone is not:

```
Cross-chunk cycle in the built renderer bundle. Chunk init order is not
guaranteed inside a cycle, so a module-scope read of an imported binding can see
`undefined`: a property access throws and kills the renderer at startup, and a
bare interpolation silently splices "undefined" into strings.

  CYCLE (2 chunks):
    - foo-A1b2C3.js
    - bar-D4e5F6.js

Fix, in order of preference:
  1. Move the module-scope read inside the function that uses it (durable — no
     chunk order can break it).
  2. Co-locate the modules in one chunk via codeSplitting.groups in the app's
     vite.config.mts (config-level; a later refactor can silently undo it).
See docs/agents/platform-contracts.md, "read them only inside a function".
```

## Testing

`scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs`, driving synthetic
fixture directories (the real verdict needs a build, which the wiring covers):

Detection controls
- two-chunk cycle `a ↔ b`
- three-chunk cycle `a → b → c → a`
- self-import
- cycle formed via `export … from` rather than `import`

False-positive controls
- acyclic diamond (`a → b`, `a → c`, `b → d`, `c → d`) is clean
- **`import()` dynamic edges are NOT counted** — the control that proves dynamic
  imports can't invent a cycle
- bare/external specifiers ignored
- a specifier naming a file that isn't an emitted chunk is ignored

Instrument controls
- both floors throw on an empty/sparse directory
- the graph builder finds a non-zero edge count on a realistic multi-import chunk

## Out of scope (deliberate, recorded)

- **The mastra AST guard stays exactly as-is.** It is not generalized — the
  invariant makes that unnecessary. It is kept because it does something the
  cycle check cannot: enforce the *coding rule* ("read inside a function") at
  review time, in seconds, with a file and line number.
- **The three chunk pins are untouched.** Note for a future reader: removing the
  `context-action-system` pin from `apps/web` and rebuilding produced zero cycles
  and a normally-mounting app (83 KB in `#root`), so that pin measures
  non-load-bearing today. That is one pin, one bundle, one local check — far
  weaker evidence than the E2E lanes that originally justified it. Do not delete
  pins on the strength of this note; it exists so the measurement isn't lost.
- **Electron main is not covered.** Node module semantics, and no scar there.
- Not a general dependency-cycle linter for source modules. **Known remaining
  gap:** two source modules that are themselves circular and land in the SAME
  chunk are concatenated in an arbitrary order by rolldown, which can throw
  the identical `ReferenceError: Cannot access 'X' before initialization` at
  init — and the chunk graph reports no cycle, because there is only one
  chunk. The accurate invariant is "acyclic chunk graph AND acyclic
  source-module graph ⇒ safe"; only the first conjunct is enforced. This
  guard removes the cross-chunk form (the shape behind all four recorded
  scars) but does not detect an intra-chunk source cycle.

## Verification plan

1. Guard reports clean on both bundles at head.
2. **Positive control:** a synthetic fixture with a genuine cycle must fail the
   real `main`, not just the unit under test.
3. Full gate green in one run: build, `lint:ci`, `type-check`, `test`,
   `test:scripts`.
4. Both E2E lanes green (they build, so they exercise the wiring).
