# Series C — C4: TypeScript 7 verify-then-adopt findings

**Outcome: (B) — parity fails. The type-check binary was NOT switched to TS7.**
`typescript@^6.0.3` remains the resolved compiler and library for every consumer.
No `package.json`, `turbo.jsonc`, or workflow file was modified by this change.
This document, plus `scripts/ts7-parity-check.mjs` (retained as a re-runnable
guard for future TS bumps), are the entire deliverable.

## TL;DR

- TS 7.0.2 is real, GA (published 2026-07-08), installable, and — for the
  ~67 `--noEmit` invocations this repo's `type-check` scripts make — **3
  diagnostics differ** across 2 independent root causes. Per the task's
  stop condition ("on ANY difference: STOP"), that is a parity failure.
- Independently, simply installing TS7 anywhere in the workspace's dependency
  graph (even under an aliased `devDependency` name) silently hijacks
  `node_modules/.bin/tsc` repo-wide — including for `tsc -b` **build** steps,
  not just type-check — because pnpm/npm bin-linking keys off the literal
  `"bin"` object key ("tsc"), not the dependency alias. This is a second,
  independent reason a naive adoption would have been unsafe even if
  diagnostics had matched.
- `typescript@^6.0.3` stays resolved for every `import ... from 'typescript'`
  consumer; this was verified for real (not assumed) — see "TS-API consumer
  verification" below.

## Step 1 — Discovery: the exact TS7 package

There is **no separate npm package name** for the GA native compiler. TypeScript
7.0 GA'd by republishing the **same** `typescript` package at major version 7,
with a restructured shape:

```
$ npm view typescript dist-tags --json
{
  "latest": "7.0.2",
  "rc": "7.0.1-rc",
  "next": "7.1.0-dev.20260714.1",
  ...
}
$ npm view typescript time --json | grep -E '"7\.0'
"7.0.1-rc": "2026-06-18T13:43:46.028Z",
"7.0.2": "2026-07-08T15:55:18.431Z"
```

`typescript@7.0.2`'s `package.json`, compared to `6.0.3`:

| field | 6.0.3 | 7.0.2 |
|---|---|---|
| `main` | `./lib/typescript.js` | *(absent)* |
| `exports["."]` | full API | `./lib/version.cjs` only |
| `exports["./unstable/*"]` | — | partial AST/fs/sync/async API (new, not the classic API) |
| `bin` | `{ "tsc": ..., "tsserver": ... }` | `{ "tsc": "bin/tsc" }` (no `tsserver`) |
| `dependencies`/`optionalDependencies` | none | 20 `@typescript/typescript-<os>-<arch>` native-binary packages |

This confirms the brief's load-bearing fact directly: **`typescript@7.x` has no
full programmatic API** (no `require('typescript').createProgram` etc. — only
`./lib/version.cjs` and an `unstable/*` AST surface unrelated to the classic
compiler API). `import ... from 'typescript'` in this repo's scripts and tests
needs the classic API, so it must keep resolving `typescript@^6.0.3`.

The pre-GA preview channel, `@typescript/native-preview`, is now a dead end —
its last publish is `7.0.0-dev.20260707.2` (the day before GA), with nothing
published since. GA absorbed the native compiler into the mainline `typescript`
package instead of keeping it a separate preview package.

**Pinned version used for all testing in this doc: `typescript@7.0.2`** (exact,
matches root's `latest` dist-tag as of 2026-07-14). No `minimumReleaseAge`
policy applies: `pnpm-workspace.yaml` documents that none is configured
today (`minimumReleaseAgeExclude` comment: "none is configured today, so this
is currently a no-op"), and `pnpm config get minimumReleaseAge` returns
`undefined`. Supply-chain check: `typescript@7.0.2` carries an npm registry
signature and is published under the same `microsoft*`/`typescript-*`
maintainer accounts as `6.0.3`, from `github.com/microsoft/TypeScript` — no
red flags, but it is worth noting the version is only 6 days old as of this
writing.

## A second, independent blocker: the `.bin/tsc` collision

Before running any diagnostics, this repo's wiring plan (add TS7 as a root
`devDependency` alias, e.g. `"typescript-native": "npm:typescript@7.0.2"`) was
tested directly. Adding that alias and running `pnpm install` produced:

```
$ node_modules/.bin/tsc --version        # root — expected 6.0.3
Version 7.0.2
$ packages/utils/node_modules/.bin/tsc --version   # a LEAF package — expected 6.0.3
Version 7.0.2
```

Both the root `.bin/tsc` **and every leaf package's own `.bin/tsc`** silently
flipped to the unverified TS7 binary, including for packages whose own
`package.json` still pins `"typescript": "^6.0.3"` as a direct dependency.
`packages/utils`'s `"build": "pnpm run clean && tsc -b . && tsup"` would have
started running its **declaration-emitting build** (not just type-check)
through TS7, silently, with zero code change to that package.

Root cause: npm/pnpm bin-linking keys off the literal `bin` object key
(`"tsc"`) declared in the dependency's own `package.json`, not the alias name
used to install it. `typescript@7.0.2` declares `"bin": {"tsc": "bin/tsc"}`
same as `6.0.3` — aliasing the *dependency name* does not rename the *linked
executable*, so any package resolving `typescript` anywhere in the graph
non-deterministically loses its `tsc` binary to whichever install happens to
win the link. This was reverted immediately
(`git status`/`git diff` confirmed clean before any further work), and the
parity script below never touches `node_modules/.bin` for the TS7 side — it
takes an explicit `--ts7-bin=<path>` argument instead, so it can never
silently pick up a wrong binary.

Had diagnostics matched, this collision would still have needed a dedicated
fix before Step 4 could safely proceed — e.g. depending directly on the
bin-less platform packages (`@typescript/typescript-<os>-<arch>`, confirmed to
ship no `"bin"` field, only a raw `lib/tsc` native executable) plus a small
platform-detection wrapper script that never touches `node_modules/.bin`.
That wiring was not built because Step 3 below already fails parity, making it
moot for this PR.

## Step 2/3 — Parity script and real results

`scripts/ts7-parity-check.mjs` discovers every workspace package with a
`type-check` script, flattens `pnpm <script>` chains (e.g. `apps/desktop`'s
`type-check` → `type-check:main` → `tsc --noEmit && tsc --noEmit --project
tsconfig.main.json`, plus `type-check:e2e`), classifies each command
(`--noEmit` run / `--build` step / non-tsc), and for every `--noEmit`
invocation runs it under both compilers from the package's own directory,
normalizing diagnostics to `relpath:line:col:TSxxxx` tuples and diffing the
sets. TS6 resolves from the repo's real `node_modules/.bin/tsc`; TS7 is passed
explicitly via `--ts7-bin` (no silent fallback if omitted — the script throws).

Full real run, `typescript@6.0.3` vs `typescript@7.0.2`, against this
worktree at commit `1989dc836` with a warm `pnpm run build` (39/39 cached,
"FULL TURBO"):

```
$ node scripts/ts7-parity-check.mjs --ts7-bin=<path-to-typescript@7.0.2>/bin/tsc

RUN   [apps/desktop --project tsconfig.main.json] ... MISMATCH  ts6=0 diag/1596ms  ts7=1 diag/106ms
  only in TS7 (1):
    + apps/desktop/tsconfig.main.json:6:25:TS5108

RUN   [packages/embeddings] ... MISMATCH  ts6=0 diag/537ms  ts7=1 diag/112ms
  only in TS7 (1):
    + packages/embeddings/src/device-detection.ts:44:13:TS2430

RUN   [packages/embeddings --project tsconfig.test.json] ... MISMATCH  ts6=0 diag/913ms  ts7=1 diag/126ms
  only in TS7 (1):
    + packages/embeddings/src/device-detection.ts:44:13:TS2430

=== Summary ===
Projects compared: 67
Projects skipped (non --noEmit): 2   (apps/web's `tsc --build --force` step; packages/secure-fs-native's `node --check`)
Mismatches: 3
Total TS6 wall time (sum of per-project spawns): 49.0s
Total TS7 wall time (sum of per-project spawns): 9.5s
Speedup: 5.14x

PARITY FAILED. Do not switch the type-check binary. See docs/series-c-ts7-parity-findings.md.
```

All 64 other `--noEmit` invocations (including `apps/web`'s two, both
`tsconfig.json` and `tsconfig.test.json`, and every `packages/*` project) came
back byte-for-byte identical diagnostic sets. This is not a wholesale
incompatibility — it is two narrow, real divergences.

### Divergence 1 — `TS5108`: `moduleResolution: "node"` (node10) is a hard error under TS7

`apps/desktop/tsconfig.main.json` (the Electron main-process CJS config)
explicitly sets `"moduleResolution": "node"`, an override of the shared
`packages/config/tsconfig/base.json` default (`"Bundler"`), because it needs
classic `require()`-style Node resolution for the Electron main process. TS7
raw output:

```
tsconfig.main.json(6,25): error TS5108: Option 'moduleResolution=node10' has been removed. Please remove it from your configuration.
```

TS6 accepts `"node"`/`"node10"` (with only a soft deprecation, no diagnostic
under `--noEmit`); TS7 treats it as a **removed, hard-error** option. This is
the only tsconfig in the entire repo using this value
(`grep -rl '"moduleResolution":\s*"node"' --include='tsconfig*.json'` matches
exactly `apps/desktop/tsconfig.main.json`), so the blast radius is narrow, but
it is a genuine "structurally identical semantics" violation: the same config
that type-checks clean under 6.x fails to even start under 7.x.

### Divergence 2 — `TS2430`: TS7's bundled DOM lib conflicts with a hand-rolled WebGPU shim

`packages/embeddings/src/device-detection.ts` declares minimal local WebGPU
types and augments the global `Navigator` interface:

```ts
interface Gpu {
  requestAdapter: (options?: GPURequestAdapterOptions) => Promise<GPUAdapter | null>;
}
declare global {
  interface Navigator {
    gpu?: Gpu;   // line 44 — this is what TS7 flags
  }
}
```

TS7 raw output: `error TS2430: Interface 'Navigator' incorrectly extends
interface 'Navigator'` (self-referential — i.e. the augmentation's shape no
longer matches the *ambient* `Navigator.gpu` typing TS7 ships in its bundled
`lib.dom.d.ts`). TS7 evidently bundles an updated DOM lib snapshot with a real
(and incompatible) `Navigator.gpu` typing, where TS6's bundled lib predates
that addition and left `Navigator.gpu` for userland to define. This is a
**lib-version drift** side effect of the major bump, independent of the
native-vs-JS engine change, and it affects both `packages/embeddings`
`tsconfig.json` and `tsconfig.test.json` (same file, both projects include it).

### Timing signal (directional, not a CI-validated number)

Real recent `Static` job "Type check" step durations on this repo's `main`,
pulled from actual `gh run view --json jobs` output (not estimated):

| run | event | duration |
|---|---|---|
| 29372551736 | pull_request | 5m59s |
| 29361940277 | pull_request | 5m38s |
| 29348769405 | pull_request | 4m53s |

This confirms the brief's "~5.5 min" figure for a cold-cache CI run. Our own
sequential per-project sum (49.0s TS6 vs 9.5s TS7, run serially on a laptop,
not through turbo's parallel scheduler) shows a consistent **~5.14x**
per-project speedup, which is real signal toward TS7's performance claims but
is not directly comparable to the CI number (different hardware, turbo runs
projects concurrently, and our sum excludes the `build` dependency turbo
would also pay). No `gh workflow run test.yml --ref <branch>` validation run
was triggered for this PR, because this PR does not modify `turbo.jsonc`, any
`package.json` script, or any workflow file — there is nothing new on the
CI path to validate. (Per the global constraint, push-path validation is
required for workflow-touching PRs; this is a docs+script-only PR.)

## Step 5 — TS-API consumer verification (typescript@6.x untouched)

No devDependency was added and nothing under `packages/*/package.json` was
touched, so this is a sanity check that the investigation itself left no
residue, run against a clean `git status`:

```
$ pnpm test:scripts
ℹ tests 123
ℹ suites 4
ℹ pass 123
ℹ fail 0

$ pnpm run arch:domain-boundaries
Architecture domain boundaries passed: 2863 imports across 3057 files; 0/0 approved boundary exceptions used.
```

Both scripts import `typescript` as a library (`ts.createSourceFile` /
`ts.createProgram`) — confirmed directly in source, not assumed:

```
scripts/verify-workspace-src-aliases.mjs:39:import ts from 'typescript';
scripts/architecture-domain-boundaries.mjs:5:import ts from 'typescript';
scripts/model-catalog-migration-contract.mjs:5:import ts from 'typescript';
scripts/check-e2e-readiness-contracts.mjs:4:import ts from 'typescript';
scripts/e2e-playwright-title-tags.mjs:3:import ts from 'typescript';
packages/db/__tests__/migration-runner-types.test.ts:2:import ts from 'typescript';
```

`node_modules/typescript/bin/tsc --version` → `6.0.3` throughout; `git status`
/ `git diff` are clean on `package.json` and `pnpm-lock.yaml` (the collision
experiment from the previous section was fully reverted before any of this
verification ran).

## Step 6 — Review gate

- No API consumer resolves to TS7 (verified above; no devDependency change
  shipped in this PR at all).
- The parity script is retained (`scripts/ts7-parity-check.mjs`) as a
  re-runnable guard: `node scripts/ts7-parity-check.mjs --ts7-bin=<path>`
  against any future TS7.x/7.1 release once it ships a programmatic API and
  these two divergences are fixed upstream or worked around locally.
- Parity failed → this PR is a report, not a switch. `package.json`,
  `turbo.jsonc`, and every workflow file are untouched.

## What would need to happen to revisit this

1. `apps/desktop/tsconfig.main.json` would need to move off
   `moduleResolution: "node"` (e.g. to `"Node16"`/`"NodeNext"` — TS6-compatible
   replacements not yet evaluated here) before it can even parse under TS7.
2. `packages/embeddings/src/device-detection.ts`'s hand-rolled WebGPU shim
   would need reconciling with whatever DOM lib snapshot TS7 ships (likely:
   drop the local `Gpu`/`GPUAdapter` shim in favor of TS7's bundled typing, or
   scope the augmentation more narrowly).
3. A collision-free wiring path for the native binary (raw
   `@typescript/typescript-<os>-<arch>` packages, no `"bin"` field, plus a
   small explicit-path wrapper) would need to be built and reviewed, since the
   naive aliased-devDependency approach is unsafe regardless of diagnostic
   parity (see the `.bin/tsc` collision section above).
4. Re-run `scripts/ts7-parity-check.mjs` clean before reconsidering adoption.
