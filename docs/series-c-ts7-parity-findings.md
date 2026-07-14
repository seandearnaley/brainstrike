# Series C — C4: TypeScript 7 verify-then-adopt findings

**Outcome: (B) — parity fails. The type-check binary was NOT switched to TS7.**
`typescript@^6.0.3` remains the resolved compiler and library for every consumer.
No `package.json`, `turbo.jsonc`, or workflow file was modified by this change.
This document, plus `scripts/ts7-parity-check.mjs` (retained as a re-runnable
guard for future TS bumps), are the entire deliverable.

## TL;DR

- TS 7.0.2 is real, GA (published 2026-07-08), installable, and — for the
  67 `--noEmit` invocations this repo's `type-check` scripts make — **3
  diagnostics differ** across 2 independent root causes. Per the task's
  stop condition ("on ANY difference: STOP"), that is a parity failure.
- Both divergences were probed with reverted scratch fixes rather than
  eyeballed. One is cheap (~6 lines, clean under both compilers). The other —
  `moduleResolution: node10`, removed in TS7 — needs a **full CJS→ESM migration
  of the Electron main process (88 errors under BOTH compilers)**. That is the
  real blocker, it is a project of its own, and its risk exceeds the prize.
- Independently, installing TS7 under an aliased root `devDependency` name
  silently takes over the **root** `node_modules/.bin/tsc`, because bin-linking
  keys off the literal `"bin"` object key (`"tsc"`), not the dependency alias.
  Per-package `.bin/tsc` is NOT affected. Scope and the measurements behind it
  are in "The root `.bin/tsc` collision" below — including a correction to an
  earlier, wider claim.
- `typescript@^6.0.3` stays resolved for every `import ... from 'typescript'`
  consumer. There are **8** such consumers, not the 6 named in the task brief;
  the brief's list was a starting point, not a census. See "TS-API consumer
  verification" for the grep that derives it.

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

## A second, independent hazard: the root `.bin/tsc` collision

> **Correction.** An earlier revision of this document claimed this collision
> reached *every leaf package's* `.bin/tsc`, and that `packages/utils`'s
> `tsc -b` build would silently run under TS7. **That was wrong**, and the
> claim is retracted. It came from a probe that ran
> `cd packages/utils && ../../node_modules/.bin/tsc --version` — which is the
> **root** bin, not the leaf's — mislabeled as the leaf's resolution. The
> measurements below are the corrected, re-run result. The hazard is real but
> **scoped to the root bin only**.

The wiring the task brief suggested (add TS7 as a root `devDependency` alias,
`"typescript-native": "npm:typescript@7.0.2"`) was tested live, then reverted.
After `rm -rf node_modules packages/*/node_modules apps/*/node_modules` and a
**fully clean** `pnpm install` with the alias present (i.e. the CI case, not an
incremental install):

```
$ node_modules/.bin/tsc --version                    # ROOT — expected 6.0.3
Version 7.0.2                                        # ← taken over

$ packages/utils/node_modules/.bin/tsc --version     # LEAF
Version 6.0.3                                        # ← unaffected

$ cd packages/utils && pnpm exec tsc --version       # what utils' scripts resolve
Version 6.0.3                                        # ← unaffected
```

Shim targets confirm this is resolution, not staleness — both shims were
rewritten by that install (mtimes one second apart), and each names its
`.pnpm` store path explicitly:

```
$ grep -o "\.pnpm/typescript@[0-9.]*" node_modules/.bin/tsc
.pnpm/typescript@7.0.2
$ grep -o "\.pnpm/typescript@[0-9.]*" packages/utils/node_modules/.bin/tsc
.pnpm/typescript@6.0.3
```

**Mechanism (one mechanism, not two).** Bin-linking keys off the literal `bin`
object key declared in the dependency's own `package.json`, not the alias used
to install it: `typescript@7.0.2` declares `"bin": {"tsc": "bin/tsc"}`, same
key as `6.0.3`, so `npm:typescript@7.0.2` under any alias still links an
executable named `tsc`. That resolves the ROOT `.bin`, which is populated from
the ROOT `package.json`'s dependencies. It does **not** propagate to leaf
packages: pnpm populates each package's `node_modules/.bin` from *that
package's own* dependency set, and `packages/utils` declares
`"typescript": "^6.0.3"` directly, so its shim resolves 6.0.3.

There is **no root-bin-to-leaf hoisting** in this repo's pnpm configuration —
tested directly, and worth recording because it is a tempting explanation:
root-only devDeps do not appear in leaf `.bin` directories.

```
$ ls packages/utils/node_modules/.bin/
esbuild  jiti  pino  playwright  stryker  terser  tsc  tsserver
tsup  tsup-node  tsx  vite  vitest  yaml
```

Every entry traces to a dependency `packages/utils` itself declares (or their
transitive deps — `tsup`→`esbuild`, `vitest`→`vite`). The root-only devDeps
`@biomejs/biome`, `lefthook`, `ultracite`, and `turbo` are **absent**, though
all four are root `devDependencies`. Any reasoning that assumes root tool bins
reach leaf `.bin` directories in this repo is unsound.

**Residual blast radius (real, but narrow).** The root `.bin/tsc` flip matters
for anything invoking `tsc` from the repo root — `pnpm exec tsc`, `npx tsc`, or
any script referencing `node_modules/.bin/tsc` by path. This repo's root
`package.json` declares no bare `tsc` script, and every per-package
`type-check`/`build` script resolves its own leaf bin, so the practical
production impact is small. But it is exactly the default `--ts6-bin` of the
parity guard in this PR — meaning a future run in a tree with TS7 installed
would have compared TS7 against TS7 and reported parity for all 67 projects.
`scripts/ts7-parity-check.mjs` therefore asserts each side's actual major
version via `tsc --version` before comparing anything, and throws on mismatch;
the TS7 side is never resolved through `node_modules/.bin` at all (it requires
an explicit `--ts7-bin=<path>`).

Had diagnostics matched, this would still have needed a deliberate wiring
decision before Step 4 — e.g. depending directly on the bin-less platform
packages (`@typescript/typescript-<os>-<arch>`, confirmed to ship no `"bin"`
field, only a raw `lib/tsc` Mach-O/ELF executable) plus a platform-detection
wrapper that never touches `node_modules/.bin`. That wiring was not built
because Step 3 fails parity, making it moot for this PR.

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

### Divergence 2 — `TS2430`: a diagnostic-**attribution** change that defeats `skipLibCheck`

> **Correction.** An earlier revision attributed this to "lib-version drift —
> TS7 bundles an updated DOM lib, TS6's predates it." **That was wrong.** The
> two bundled `lib.dom.d.ts` files are *byte-identical*
> (`diff -q` reports no difference; `Navigator extends ... NavigatorGPU ...` is
> at line 25780 and `readonly gpu: GPU` at 25951 in **both**). The real cause is
> more interesting, and is established by isolated repro below.

`packages/embeddings/src/device-detection.ts` augments the global `Navigator`:

```ts
interface Gpu {
  requestAdapter: (options?: GPURequestAdapterOptions) => Promise<GPUAdapter | null>;
}
declare global {
  interface Navigator {
    gpu?: Gpu;   // line 44 — optional, and narrower than lib.dom's `readonly gpu: GPU`
  }
}
```

TS7 raw output (unelided — the earlier revision quoted this wrong too; it names
`NavigatorGPU`, not a self-referential `Navigator`):

```
src/device-detection.ts(44,13): error TS2430: Interface 'Navigator' incorrectly extends interface 'NavigatorGPU'.
  Types of property 'gpu' are incompatible.
    Type 'Gpu' is missing the following properties from type 'GPU': wgslLanguageFeatures, getPreferredCanvasFormat
```

**The augmentation is genuinely unsound, and BOTH compilers detect it.** A
minimal standalone repro (its own tsconfig, no repo config involved — just the
augmentation shape above against `lib: ["DOM", ...]`) isolates the real
variable, which is `skipLibCheck`:

| `skipLibCheck` | TS 6.0.3 | TS 7.0.2 |
|---|---|---|
| `false` | `lib.dom.d.ts(25780,11): error TS2430` | `lib.dom.d.ts(25780,11): error TS2430` |
| `true`  | *clean* | `repro.ts(8,13): error TS2430` |

With `skipLibCheck: false` the two compilers agree **exactly**, down to the
file and position. The divergence appears only under `skipLibCheck: true`,
because the two compilers **attribute the same diagnostic to different files**:
TS6 blames `lib.dom.d.ts` (a lib file → suppressed by `skipLibCheck`), TS7
blames the user's augmentation site (not a lib file → not suppressed).
`packages/embeddings` sets `skipLibCheck: true` (as does
`packages/config/tsconfig/base.json`), which is why it surfaces there.

So TS7 is arguably the **more correct** of the two here: the code really is
unsound, and TS6 was only hiding it behind an attribution accident. But it is
still a "structurally identical semantics" violation in the strict sense — same
input, different reported diagnostics — and it is a *class*, not a one-off: any
`skipLibCheck`'d project with an unsound global augmentation could surface new
errors under TS7. Across all 67 projects here, exactly one did.

### Are the divergences trivial to fix? Tested, not assumed.

Both were probed with throwaway local edits, each reverted immediately
(`git status` clean after each). Results, under **both** compilers:

**Divergence 1 (`moduleResolution`) — NOT trivial. This is the blocker.**

| variant | TS 6.0.3 | TS 7.0.2 |
|---|---|---|
| `module: CommonJS` + `moduleResolution: node` *(as shipped)* | **clean** | 1 × TS5108 |
| `moduleResolution: node16` (alone) | 1 × TS5110 | 1 × TS5110 |
| `moduleResolution: nodenext` (alone) | 1 × TS5110 | 1 × TS5110 |
| `module: Node16` + `moduleResolution: Node16` *(the paired fix)* | **88 errors** | **88 errors** |
| `moduleResolution: bundler` | 1 × TS2379 | 1 × TS2379 |

Changing `moduleResolution` alone fails (`TS5110: Option 'module' must be set to
'Node16'...`). Pairing it with `module: Node16` — the natural fix — produces
**88 diagnostics under both compilers**: `TS1479` (CommonJS file importing an
ESM-only dependency: `@brainstrike/db`, `@brainstrike/text-splitter`,
`strip-ansi`), `TS2835` (relative imports now need explicit `.js` extensions),
`TS1541` (type-only ESM import needs a `resolution-mode` attribute), and so on.
That is a **full CJS→ESM module-semantics migration of the Electron main
process**, not a config tweak — and it changes emit, so it carries real runtime
risk for a process that (per the Series B finding) executes its `dist` directly.
`bundler` clears TS5108 with only one pre-existing error surfaced, but bundler
resolution is semantically wrong for a Node-executed main process. Both
compilers agree throughout, which is worth noting: TS7's *checking* is faithful.
The blocker is the removed option plus the migration it forces.

**Divergence 2 (WebGPU) — cheap. ~6 lines, clean under both compilers.**

Naively deleting the shim does NOT work: it yields 4 × `TS2339` under both
compilers, because the code probes legacy adapter members lib.dom does not
declare (`requestAdapterInfo`, `isFallbackAdapter`) — the shim exists for a
reason. The surgical fix is to drop only the *unsound* `Navigator.gpu`
augmentation (lib.dom already declares it) and augment `GPUAdapter` with just
the legacy optional members.

This is the **complete** change to
`packages/embeddings/src/device-detection.ts` — all three parts are required.
Applying only parts 1+2 leaves a dangling reference to the deleted `Gpu` type
and fails with `src/device-detection.ts(123,40): error TS2552: Cannot find name
'Gpu'. Did you mean 'GPU'?` (1 error, identical under both compilers). Part 3 is
not optional.

**Part 1 — delete** the entire hand-rolled shim block (everything from the
comment `// WebGPU types for environments where @webgpu/types is not available`
through the closing brace of the `declare global { interface Navigator { ... } }`
block — the local `GPURequestAdapterOptions`, `GPUAdapterInfo`,
`GPUSupportedLimits`, `GPUAdapter`, and `Gpu` interfaces, plus the `Navigator`
augmentation). lib.dom.d.ts already provides all of these except the two legacy
members re-added in part 2.

**Part 2 — insert** in its place:

```ts
// lib.dom.d.ts already declares `Navigator.gpu: GPU` (via NavigatorGPU) and the
// GPU/GPUAdapter types. It does NOT declare the legacy adapter members this
// module still probes, so augment ONLY those. Augmenting `Navigator.gpu` here
// would be unsound (lib.dom has it required + typed `GPU`).
declare global {
  interface GPUAdapter {
    readonly isFallbackAdapter?: boolean;
    requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
  }
}
```

**Part 3 — update the surviving call site.** Deleting the local `Gpu` interface
orphans one reference to it (the only one outside the deleted block):

```ts
// before
async function probeWebGPUAdapter(gpu: Gpu): Promise<WebGPUProbeResult> {
// after
async function probeWebGPUAdapter(gpu: GPU): Promise<WebGPUProbeResult> {
```

Result with all three parts applied: **0 errors under TS6 and 0 under TS7**, for
both `tsconfig.json` and `tsconfig.test.json`. (Verified by applying the above
verbatim to a clean tree, then reverting — this snippet is the tested artifact,
not a paraphrase of one.)

Reverted — it is not part of this PR (it is a real, standalone soundness fix
that deserves its own change, and shipping it here would bundle unrelated work
into a findings PR).

**Net:** divergence 2 is a cheap pre-req; divergence 1 is the real blocker and
is a project of its own.

### Timing signal (directional, not a CI-validated number)

Real recent `Static` job "Type check" step durations on this repo's `main`,
pulled from actual `gh run view --json jobs` output (not estimated):

| run | event | duration |
|---|---|---|
| 29372551736 | pull_request | 5m59s |
| 29361940277 | pull_request | 5m38s |
| 29348769405 | pull_request | 4m53s |

This confirms the brief's "~5.5 min" figure for a cold-cache CI run.

Our own sequential per-project sums, from two full runs of the parity script on
the same laptop, illustrate what is and isn't trustworthy in a local number:

| run | TS6 total | TS7 total | ratio |
|---|---|---|---|
| first (quiet machine) | 49.0s | 9.5s | **5.14x** |
| re-run (under background load) | 98.4s | 20.0s | **4.93x** |

The absolute times are worthless as a CI predictor — they doubled purely from
machine load — but the **ratio is stable at ~4.9–5.1x**, and the 3 mismatch
identities were byte-identical across both runs. So: real signal toward TS7's
speed claims, no support for a specific CI-minutes figure. Not directly
comparable to the CI number either (different hardware, turbo runs projects
concurrently rather than serially, and our sum excludes the `build` dependency
turbo would also pay). Anyone quoting a projected CI saving from this document
is over-reading it; measure it in CI. No `gh workflow run test.yml --ref <branch>` validation run
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
`ts.createProgram`), so both would break outright against `typescript@7.x`
(which exports no classic API).

### The full TS-API consumer census, and how to re-derive it

**Do not treat this list as static — re-run the grep.** The list below is
derived mechanically, not copied from a plan document. An earlier draft of this
doc carried a hand-authored 6-entry list inherited from the task brief and
**missed two real consumers**; the census below is the corrected, grep-derived
one. Whoever attempts adoption must re-run this command rather than trust the
table, because "confirm no API consumer accidentally resolves to TS7" is only a
safe gate if the list is exhaustive at that moment:

```
$ grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=.turbo \
    -E "(from|require\()\s*['\"]typescript['\"]" .

scripts/model-catalog-migration-contract.mjs:5:import ts from 'typescript';
scripts/check-e2e-readiness-contracts.mjs:4:import ts from 'typescript';
scripts/e2e-playwright-title-tags.mjs:3:import ts from 'typescript';
scripts/verify-workspace-src-aliases.mjs:39:import ts from 'typescript';
scripts/architecture-domain-boundaries.mjs:5:import ts from 'typescript';
packages/db/__tests__/migration-runner-types.test.ts:2:import ts from 'typescript';
packages/db/__tests__/runtime-import-extensions.test.ts:3:import ts from 'typescript';
apps/desktop/src/platform/runtime-host-boundary.ts:3:import ts from 'typescript';
```

**8 consumers, not 6.** The two that a brief-derived list missed:

- `packages/db/__tests__/runtime-import-extensions.test.ts` — `ts.createSourceFile`,
  `ts.isImportDeclaration`, `ts.isStringLiteral`, `ts.isExportDeclaration`,
  `ts.ScriptTarget`.
- `apps/desktop/src/platform/runtime-host-boundary.ts` — `ts.isStringLiteral`,
  `ts.SyntaxKind`, `ts.isIdentifier`, and the `ts.ImportDeclaration` /
  `ts.ExportDeclaration` / `ts.CallExpression` types. **Note this one lives in
  app `src/`, not under `scripts/` or `__tests__/`** — it is the architectural
  guard enforcing the renderer-only-inference invariant, imported only by its
  own test, but it sits inside the desktop app's type-check project. A search
  scoped to "scripts and tests" would not find it.

Every one of the 8 uses the classic compiler API (`createSourceFile` /
`createProgram` / `SyntaxKind` / node-type guards), none of which exists in
`typescript@7.0.2`'s `exports` map (`./lib/version.cjs` + `unstable/*` only).
All 8 must keep resolving `typescript@^6.0.3`.

Completeness of the census was checked against three other import shapes, all
of which returned nothing: subpath imports (`from 'typescript/...'`), dynamic
`import('typescript')` / `createRequire(...)('typescript')` / `require.resolve`,
and a deliberately over-broad `-E "['\"]typescript['\"]"` sweep across all
`.ts/.tsx/.mjs/.js/.cjs` files (whose extra hits are all language-name string
literals — `language: 'typescript'`, shiki/chunking maps — plus
`checkers: ['typescript']` in the per-package `stryker.config.*` files, which
names the `@stryker-mutator/typescript-checker` plugin rather than importing
the module; that plugin resolves `typescript` through its own dependency and is
an INDIRECT consumer worth keeping in mind under any future remediation).

`node_modules/typescript/bin/tsc --version` → `6.0.3` throughout; `git status`
/ `git diff` are clean on `package.json` and `pnpm-lock.yaml` (the collision
experiment from the previous section was fully reverted before any of this
verification ran).

## Step 6 — Review gate

- No API consumer resolves to TS7 (verified above; no devDependency change
  shipped in this PR at all). All **8** are enumerated by a grep that a reader
  can re-run — the census is reproducible, not hand-maintained.
- The parity script is retained (`scripts/ts7-parity-check.mjs`) as a
  re-runnable guard: `node scripts/ts7-parity-check.mjs --ts7-bin=<path>`
  against any future TS7.x/7.1 release once it ships a programmatic API and
  these two divergences are fixed upstream or worked around locally.
  It refuses to report a vacuous pass: it throws if discovery finds fewer than
  `MIN_TYPECHECK_PACKAGES` packages, if it compares fewer than
  `MIN_COMPARED_PROJECTS` projects (or zero under `--filter`), or if either
  binary's actual `tsc --version` major is not the one expected — the last of
  which matters because installing TS7 takes over the root `node_modules/.bin/tsc`
  that is this script's own default TS6 candidate.
- Parity failed → this PR is a report, not a switch. `package.json`,
  `turbo.jsonc`, and every workflow file are untouched.

## What would need to happen to revisit this

Ordered cheapest-first. Steps 1–2 are small; step 3 is the one that decides
whether TS7 adoption is worth it at all.

1. **Fix the WebGPU augmentation** in
   `packages/embeddings/src/device-detection.ts` — the ~6-line surgical change
   tested above (drop the unsound `Navigator.gpu` augmentation, augment
   `GPUAdapter` with the legacy optional members instead). Verified clean under
   both compilers. Worth doing on its own merits regardless of TS7: the current
   augmentation is genuinely unsound and TS6 only hides it via `skipLibCheck`
   attribution.
2. **Build a collision-free wiring path** for the native binary (raw
   `@typescript/typescript-<os>-<arch>` packages — no `"bin"` field — plus an
   explicit-path wrapper that never touches `node_modules/.bin`), since the
   aliased-devDependency approach takes over the root `.bin/tsc`.
3. **Decide the `apps/desktop/tsconfig.main.json` question — the real blocker.**
   `moduleResolution: node10` is removed in TS7, and the paired fix
   (`module: Node16` + `moduleResolution: Node16`) surfaces **88 errors under
   both compilers** — a full CJS→ESM migration of the Electron main process,
   with emit changes and real runtime risk. This is a project in its own right,
   not a config tweak, and it should be justified on its own terms (module
   hygiene) rather than as collateral of a type-check speedup. Note it is
   independent of TS7 and could be done — or rejected — separately. Until it is
   resolved, TS7 cannot type-check the desktop main project at all.
4. **Re-run `scripts/ts7-parity-check.mjs` clean** before reconsidering
   adoption:
   `node scripts/ts7-parity-check.mjs --ts7-bin=<path-to-7.x-tsc>`.
   Re-derive the TS-API consumer census with the grep above at the same time —
   do not trust this document's table, which is a snapshot.

**Is it worth it?** The measured per-project speedup is real (~5.14x on the
sequential local sum; CI's Type check step is a genuine ~5–6 min). But the
price of entry is an Electron-main module migration whose own risk is
substantially larger than the prize, and TS7 offers no programmatic API until
7.1 — so the 8 API consumers pin `typescript@6.x` in the tree regardless,
meaning adoption means running two TypeScript majors side by side. A re-look
once 7.1 ships (programmatic API, and possibly a softer stance on the removed
resolution modes) is likely a better use of the effort than forcing it now.
