# Bespoke lint-gate audit — 2026-10-15

Audited the 18 bespoke gates chained into the root `lint` / `lint:ci` scripts
against the canonical tooling already installed (Biome 2.5.14, ESLint 10.10.0,
knip 6.34.0, Turborepo 2.11.2, pnpm `catalogMode: strict` + `minimumReleaseAge`,
tsup 8.5.1, TypeScript).

**Result: 1 of 18 is provably covered. `lint:no-no-memo` was retired**, in the
follow-up that also corrected this document; see
[§ `lint:no-no-memo`](#correction-lintno-no-memo-is-replaceable) below. The
other 17 stand. Three of the four retirement hypotheses that prompted this audit
were disproven by measurement; the fourth had no target among the 18.

**This document originally concluded 0 of 18, and was wrong about one gate.**
The audit tested a Biome GritQL plugin and ESLint's bulk suppressions as
canonical candidates for `lint:no-no-memo` but never tested ESLint's own core
`no-restricted-syntax` rule, which turns out to cover it strictly better. A
Codex review on PR #3629 caught the omission. The correction is recorded in
place rather than rewritten away, because the failure mode — surveying the
candidates you thought of and reading the result as "no candidate exists" — is
the more useful lesson than the verdict.

This document exists so the same four proposals are not re-opened from the names
of the scripts. Each verdict below is backed by an executed experiment, not by
reading rule catalogues.

## Why the audit was proposed, and what measurement showed

### 1. `lint:no-source-cycles` — "Biome and ESLint have cycle detection"

Biome 2.5.14 does ship `lint/suspicious/noImportCycles` (domain `project`,
default severity `warn`, not currently enabled). It is not a replacement.

Method: enable the rule, plant cycles of four different shapes, run
`biome check . --reporter=json` over the whole repo and compare against
`node scripts/verify-no-source-cycles.mjs`.

| planted cycle | bespoke guard | Biome `noImportCycles` |
| --- | --- | --- |
| same package, relative `./x.js` naming a `.ts` file | n/a (out of renderer scope) | **FLAGGED** |
| same package, relative extensionless | n/a | **FLAGGED** |
| cross-package, **both edges relative** (`../../hooks/src/…`) | n/a | **FLAGGED** |
| cross-package, **`@brainstrike/*` specifiers** | **FLAGGED** (named all 3 modules) | **MISSED** |

The rule is live — it caught three of four shapes, so the miss is a blind spot
and not a dead rule. The isolating variable is the specifier form, not the
package boundary: the identical cycle is caught through `../../` and missed
through `@brainstrike/*`. Biome resolves a workspace specifier through the
package's `exports` map, which points at `./dist/*.js` and `./dist/*.d.ts` —
build output, absent or stale during a lint-only run — so the edge drops. The
bespoke guard resolves through `packages/test-utils/workspace-src-aliases.mjs`
to `src`, which is why it sees the real source graph (2260 renderer modules).

This repo imports cross-package almost exclusively via `@brainstrike/*`, i.e.
the exact edge class the guard's own header records every scar of this bug in.

**Verdict: KEEP.** A canonical replacement would silently stop analyzing the
edges the guard exists for.

**Also found, and currently unguarded:** with the rule enabled, Biome reports 22
pre-existing cycles outside the bespoke guard's declared renderer scope — 6 in
`apps/desktop/src/assistant-server/` (Electron main), 11 in
`packages/agent/src/mastra/`, 3 in `packages/assistant-service/`, 2 in
`packages/app-shell/`. Nothing enforces cycle-freedom on those paths today. The
two instruments are complementary, not redundant. Worth its own change; not
touched here.

### 2. `lint:package-build-strategies` + `lint:tsup-build-invariants` — "a shared build config plus the build tool's own validation"

Already evaluated and rejected with measurement, recorded in the header of
`scripts/verify-tsup-build-invariants.mjs`: BST-746 proposed exactly this
`createTsupConfig` factory. At the time 9 of 18 configs were simple and they
genuinely diverged on output-affecting fields (`sourcemap`, `format`, `target`,
`splitting`). A factory would have unified the four fields that must stay
different while doing nothing to stop the two that must stay the same
(`clean`, `dts`) from drifting, and would have added 8 build-graph edges or
landed in the config-load hash-gap class.

The second half — "the build tool's own validation" — does not exist. tsup
validates its option *schema*; it has no notion that `clean: true` is
catastrophic specifically in a `tsc -b . && tsup` package, which is the whole
invariant. Nor does it know the inverse obligation for the three tsup-owned
packages (`chunking-worker`, `file-tree-worker`, `token-cache`), where
declaration emit must be **on** or the package ships no `.d.ts`.

**Verdict: KEEP both.** Re-litigating a measured rejection needs new evidence,
and there is none.

### 3. `lint:catalog-user-choice` — "pnpm already runs `catalogMode: strict`"

The hypothesis is aimed at the wrong script. This gate has nothing to do with
pnpm dependency catalogs. It scans `packages/db/src/migrations/*.ts` for
`is_enabled = EXCLUDED.is_enabled` — a **model catalog** seed upsert clobbering
the user's per-model enable/disable choice — and count-pins 6 historical
occurrences across migrations 026 and 028 under BST-667.

The pnpm dependency-catalog rule described by the hypothesis lives in
`scripts/verify-catalog-references.mjs` (588 lines), which is **not** one of the
18 gates and was out of scope for this audit.

**Verdict: KEEP.** A domain invariant over SQL text; no tool covers it, and
`catalogMode: strict` is unrelated to it.

### 4. Dead-export / unused-dependency checks — "knip 6.x can follow tsconfig references"

**No gate among the 18 performs dead-export or unused-dependency analysis.**
knip is already wired independently as the root `knip` script, with three
contract tests (`knip-audit-contract`, `knip-liveness`, `knip-workflow`). There
was nothing here to retire or replace.

### 5. `lint:eslint` — ESLint 10's built-in bulk suppressions

Not in the original hypotheses, but the strongest remaining candidate: ESLint
10.10.0 ships `--suppress-all`, `--suppress-rule`, `--prune-suppressions` and a
per-file-per-rule `eslint-suppressions.json`, which is canonically the same
shape as the bespoke per-rule ratchet in
`scripts/verify-eslint-warning-baselines.mjs`.

Measured: **bulk suppressions are error-severity only.**

```
$ eslint packages/hooks/src --suppress-all --suppressions-location supp.json
✖ 4 problems (0 errors, 4 warnings)
$ cat supp.json
{}
```

The feature is live — a planted `react-hooks/rules-of-hooks` error (severity 2)
*was* captured, with `{"count": 1}` — so the empty file is a capability limit,
not a broken flag. Every one of the 355 findings this gate budgets across 8
rules is **warn** severity by deliberate design (compiler diagnostics as
warnings, `eslint-warning-baseline.json`). Canonical suppressions would track
**0 of 355**.

**CORRECTED 2026-10-15 (#3629 review).** This section originally claimed a
second distinction: that only the bespoke gate hard-fails when a rule falls
**below** its baseline. That was backwards, and it is removed rather than
preserved as historical evidence. Measured against the installed ESLint 10.10.0,
an unused suppression fails by DEFAULT:

```
$ eslint <file> --suppressions-location s.json   # baseline says 2, real count is 1
There are suppressions left that do not occur anymore. To resolve this, re-run the
command with `--prune-suppressions` to remove unused suppressions. To ignore unused
suppressions, use `--pass-on-unpruned-suppressions`.
$ echo $?
2
$ eslint <file> --suppressions-location s.json --pass-on-unpruned-suppressions; echo $?
0
```

So suppressions DO have a burn-down hard failure, and `--pass-on-unpruned-suppressions`
is the opt-out from it, not the mechanism that creates it. The error-only limit
above is the whole reason suppressions cannot be adopted here — it does not need
a second argument propping it up.

**Verdict: KEEP** — on the error-only limit alone.

## Evidence table — all 18

Timings are a single warm run on an M-series Mac, `node scripts/<gate>.mjs`
measured individually. For scale: the 18 gates total **50.2s**, of which
`lint:eslint` alone is 23.3s; `biome check .` on the same tree is **50.7s**. The
bespoke chain minus the canonical ESLint run is ~27s — it is not the cost driver
in this lane.

| gate | what it actually checks (from the source) | time | canonical coverage | verdict |
| --- | --- | --- | --- | --- |
| `lint:no-no-memo` | **RETIRED.** Forbade the `"use no memo"` React Compiler escape directive across `apps/**`, `packages/**`, `scripts/**`, root configs — 8 extensions. | 3.2s | **YES** — ESLint core `no-restricted-syntax` with the selector `ExpressionStatement > Literal[value='use no memo']`, which catches a strict superset. See the correction section. | **RETIRE** |
| `lint:assistant-run-id-producer` | Pins runId *provenance*: `createThreadRunId` declared once, one call site, not exported, and the `HostRunId` brand asserted exactly once. Stops a second producer minting an id without the parent `brainstrike_assistant_thread_runs` row. | 1.52s | **No** — an identity/reach assertion over one symbol plus a branded type. | **KEEP** |
| `lint:mastra-stream-chunk-contract` | Asserts the source text of 3 files still *contains* the type-level chunk-disposition machinery (`StaticMastraChunkType` exclusion, the string-widening assertion, the `Record<StaticMastraChunkType, …>` inventory). | 0.26s | **No.** `tsc` enforces the exhaustiveness; this gate enforces that the enforcement still exists. Delete the `Record<…>` and tsc goes quiet — a false green. A liveness instrument for a type-level check. | **KEEP** |
| `lint:browser-events-literals` | Forbids the 3 `brainstrike:*` embedding-queue CustomEvent name literals outside `packages/utils/src/browser-events.ts` and its test. Prevents the pre-BST-580 drift where 3 packages dispatched `queue-drained` with divergent detail shapes. | 3.10s | **No** canonical forbidden-string-literal-with-path-allowlist rule. Same GritQL caveat as `no-no-memo`. | **KEEP** |
| `lint:catalog-user-choice` | **Not pnpm catalogs.** Scans db migrations for `is_enabled = EXCLUDED.is_enabled` clobbering the user's model enable choice; count-pins 6 historical occurrences (026, 028) under BST-667. | 0.10s | **No** — unrelated to `catalogMode: strict`. See §3. | **KEEP** |
| `lint:e2e-destructive-tags` | Any `factory-reset` selector/route or "Factory Reset" UI text in `apps/{web,desktop}/e2e` must sit inside a `@destructive`-tagged Playwright title. | 0.53s | **No** — Playwright has no tag-requirement check. | **KEEP** |
| `lint:e2e-readiness-contracts` | AST-level: web e2e `test()` calls must honour the readiness-fixture contract. | 0.43s | **No** | **KEEP** |
| `lint:mastra-schema-init-order` | No module-scope read of a `mastra-memory-schema` constant. Guards the PR #1978 defect where adding one unrelated static import reordered chunk init and turned both E2E lanes red. | 1.55s | **No**, and the header enumerates why: tsc types identically either way; no lint rule models chunk-evaluation order; Vitest always evaluates in dependency order; the schema module imports nothing so there is no cycle to find. Only a production build has a chunk graph. | **KEEP** |
| `lint:no-source-cycles` | Acyclic renderer **source** graph (2260 modules), resolved through the workspace src-alias registry, with dynamic/`?worker`/`new URL` targets as traversal roots but not edges. | 3.70s | **Partial and in the wrong half.** Biome `noImportCycles` misses `@brainstrike/*` edges — proven in §1. | **KEEP** |
| `lint:private-test-input-locality` | Nothing outside `packages/types` may read its private test files, so narrowing that package's topo inputs stays cache-correct. AST-tracks fs-read aliases and partially-static paths, failing closed. | 5.66s | **No.** `turbo boundaries` checks *declared* imports, not reads of undeclared input paths; Turborepo cannot detect a read of a file that is not a declared input. | **KEEP** |
| `lint:no-raw-nul-bytes` | No tracked JS/TS file contains a raw `0x00`. A single NUL makes `grep`/`git grep` skip the file silently, so it drops out of code search. Enumerated via `git ls-files`, scoped by extension. | 0.38s | **No** — a valid string character to every parser; Biome and tsc both accept it. | **KEEP** |
| `lint:model-catalog-migrations` | Model/provider catalog row-mutation ledger: remap contract for removed models from v33, provider-id sets, insert-column-list conformance. | 1.64s | **No** — domain invariant over migration SQL. | **KEEP** |
| `lint:package-build-strategies` | Typed libs build with `tsc -b`; every src→dist lib prunes stale emit without erasing `.tsbuildinfo`; tsup reserved for the 8 real bundle boundaries; no leftover tsup config/deps after a move to tsc emit. Anti-vacuity floors (41/31/30/14/8). | 0.48s | **No.** See §2 — factory measured and rejected (BST-746). | **KEEP** |
| `lint:tsup-build-invariants` | Conditional invariant: TypeScript-owned packages must state literal `clean: false` / `dts: false`; the 3 tsup-owned packages must have declaration emit **on**. Models all 4 CLI dts flags and both config keys; rejects dynamic expressions. | 0.09s | **No.** tsup validates option schema, not this invariant. See §2. | **KEEP** |
| `lint:minimum-release-age-exclusions` | Every `minimumReleaseAgeExclude` entry expires: window derived from the configured floor (1440 min) + grace, against a committed publish-date ledger, 1:1 with the YAML in both directions. | 0.07s | **No.** pnpm enforces the floor and honours the exclude list but has no expiry concept — an exclusion is permanent until a human removes it, which is the failure this gate exists for (`@mastra/core@1.50.0` sat exempt for a month covering a version the repo no longer installed). | **KEEP** — the supply-chain control. |
| `arch:domain-contract` | Validates `architecture/domain-map.json` against the real workspace: every `apps/*` and `packages/*` is assigned to exactly one of 8 domains. | 0.08s | **No** | **KEEP** |
| `arch:domain-boundaries` | Enforces the 8-domain DAG over actual import edges, zero exceptions (`domain-map.json` has no `exceptions` key). | 5.94s | **No.** `turbo boundaries` is already wired separately as `pnpm run boundaries` and enforces a *different* invariant — whether an import is **declared** in package.json, not whether the domain DAG **allows** it. Complementary. | **KEEP** |
| `lint:eslint` | Per-rule ESLint warning ratchet over 17 source roots: zero errors, no rule over *or under* baseline, no undeclared warning family, floor of 500 linted files. | 23.32s | **No.** ESLint 10 bulk suppressions are error-only — 0 of 355 warn findings captured. See §5. | **KEEP** |

Two Mastra gates were to be flagged "possibly dead pending the Mastra deletion".
That premise collapsed: the concurrent session stopped before editing and
recorded that the loop is **not** orphaned — `streamMastraAgent` is live behind
the Hosted Web `POST /api/assistant` route via
`packages/agent/src/message-utils.ts:301`. Both gates guard live production
code.

## Correction: `lint:no-no-memo` IS replaceable

Raised by a Codex review on PR #3629, verified here, and acted on. The original
verdict rested on two candidates — a Biome GritQL plugin (works, but
`biome.json` `files.includes` is `src`-only and omits `.mjs/.cjs/.cts/.mts` and
`scripts/**`) and ESLint bulk suppressions (error-only). Neither is ESLint's
core `no-restricted-syntax`, which was never measured. It should have been: the
rule's documented AST selectors cover this exactly.

### Detection: a strict superset, measured on 10 planted variants

| variant | bespoke regex | `no-restricted-syntax` |
| --- | --- | --- |
| `"use no memo";` in `.ts` | catch | catch |
| `'use no memo'`, no semicolon | catch | catch |
| indented | catch | catch |
| **inline in a one-line body** (`function f() { "use no memo"; return 1; }`) | **MISS** | **catch** |
| **`"use\u0020no memo"`** (escaped spelling) | **MISS** | **catch** |
| `` `use no memo` `` (template literal) | skip | skip — the React Compiler does not honour it either, so this is parity |
| `.mjs` / `.cjs` / `.mts` / `.jsx` | catch | catch |

The two misses are structural, not incidental. The script's regex is
line-anchored (`^\s*(['"])use no memo\1;?\s*$`), so it cannot see a directive
sharing a line with other code; and it compares source TEXT, so any escaped
spelling slips past. The selector compares the PARSED value, so both are caught.

### Surface: equal, and proven so

Retiring the script narrows nothing. The new `eslint.config.js` block carries
the script's four globs and all eight extensions verbatim, and `TARGETS` in
`scripts/verify-eslint-warning-baselines.mjs` gained `apps`, `packages` and
`scripts` so the verifier actually visits them — without that, the rule would
have been configured but never run, which is the false green this repo's
contract tests exist to catch.

Proven end to end by planting 6 violations and running the real gate, which
failed with all 6:

```
packages/hooks/src/selprobe/v1.ts:1:1      plain directive
packages/hooks/src/selprobe/v4.ts:1:23     inline (regex MISSED this)
packages/hooks/src/selprobe/v5.ts:1:1      escaped  (regex MISSED this)
packages/hooks/src/selprobe/v7.mjs:1:1     .mjs extension
packages/types/src/outside-the-17.ts:1:1   a package outside the react block
scripts/selprobe/s1.mjs:1:1                scripts/**
→ Error: eslint: 6 error-severity finding(s). Errors never get a budget.
```

No baseline entry is needed: the rule is `error`, and the ratchet's rule 1 is
zero error-severity findings, always.

### Why this is also a liveness improvement

A regex cannot silently stop matching; an AST selector can. A
`no-restricted-syntax` selector that no longer resolves reports zero and reads
exactly like a clean repo — the BST-1220 class. So the replacement adds a case
to `scripts/__tests__/lint-rule-liveness-contract.test.mjs` driving a known
violation through the shipping config. The retirement holds only while that
case does.

### THE COST, which is the real caveat

Pointing the verifier at the full surface takes it from 2129 to 8067 files:

| | cold (no ESLint cache) | warm |
| --- | --- | --- |
| before | 24.2s | — |
| after | **100.1s** | 3.8s |

**+76s on a cold run, to retire a 3.2s script.** Warm runs are cheap and are the
common case locally, since the cache persists; cold runs happen on any lockfile
or `eslint.config.js` change (both are in the cache key) and in every fresh
worktree — which is how the parallel sessions in this repo work, so it is not a
rare path.

That is a genuine trade, not a free win: strictly stronger enforcement and one
less bespoke script, against a slower cold lint. It is recorded here rather than
resolved silently. Two narrower options were considered and rejected: scoping the
rule to the react block's 17 source roots costs nothing extra but IS a real
narrowing (the compiler runs `compilationMode: 'infer'` over each renderer's
whole bundle graph, which spans far more packages than those 17), and excluding
test files would be a narrowing the audit's own rule forbids without proof.

## Follow-ups this audit surfaced (not done here)

1. **`verify-no-source-cycles` silently drops `@brainstrike/*` edges it cannot
   alias-resolve.** `classifySpecifier` classifies any non-relative specifier
   with no alias match as a third-party package, but a `@brainstrike/*`
   specifier is never third-party here — so the edge vanishes instead of being
   reported as unresolved, which `EXPECTED_UNRESOLVED` being deliberately empty
   is supposed to make impossible. A cross-package cycle planted through
   `@brainstrike/hooks/use-app-active` was reported **clean**. Treating the
   scope as `unresolved` instead surfaces 6 real dropped edges in live renderer
   code today, all of them legitimately exported subpaths the registry does not
   map:

   ```
   @brainstrike/embedding-worker/vite    apps/web/src/create-embedding-queue.ts
   @brainstrike/embedding-worker/vite    apps/desktop/src/renderer/create-embedding-queue.ts
   @brainstrike/embedding-worker/vite    apps/desktop/src/renderer/components/llm-host-runtime.tsx
   @brainstrike/embedding-worker/vite    apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   @brainstrike/embedding-worker/worker  apps/web/src/embedding-model-switch-memory-probe.worker.ts
   @brainstrike/agent/mcp-tasks          apps/desktop/src/renderer/components/mcp-task-status-e2e-harness.tsx
   ```

   `@brainstrike/embedding-worker` exports `./worker` and `./vite`;
   `@brainstrike/agent` exports `./mcp-tasks`. Resolving them, then re-running
   the guard, is a strict strengthening — kept out of this change because it is
   a behaviour change to a guard, not a retirement.

2. **22 unguarded import cycles** in Electron-main and Node paths that Biome's
   `noImportCycles` reports and nothing enforces (§1).
