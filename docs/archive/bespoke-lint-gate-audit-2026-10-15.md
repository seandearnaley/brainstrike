# Bespoke lint-gate audit — 2026-10-15

Audited the 18 bespoke gates chained into the root `lint` / `lint:ci` scripts
against the canonical tooling already installed (Biome 2.5.14, ESLint 10.10.0,
knip 6.34.0, Turborepo 2.11.2, pnpm `catalogMode: strict` + `minimumReleaseAge`,
tsup 8.5.1, TypeScript).

**Result: 0 of 18 are provably covered by an installed canonical tool. Nothing
was retired.** Three of the four retirement hypotheses that prompted this audit
were disproven by measurement; the fourth had no target among the 18.

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

It is also strictly less strict in a second way: the bespoke gate fails when a
rule falls **below** its baseline, which is what banks a burn-down instead of
letting freed headroom become budget for the next regression. Suppressions have
`--pass-on-unpruned-suppressions` but no equivalent hard failure.

**Verdict: KEEP.**

## Evidence table — all 18

Timings are a single warm run on an M-series Mac, `node scripts/<gate>.mjs`
measured individually. For scale: the 18 gates total **50.2s**, of which
`lint:eslint` alone is 23.3s; `biome check .` on the same tree is **50.7s**. The
bespoke chain minus the canonical ESLint run is ~27s — it is not the cost driver
in this lane.

| gate | what it actually checks (from the source) | time | canonical coverage | verdict |
| --- | --- | --- | --- | --- |
| `lint:no-no-memo` | Forbids the `"use no memo"` React Compiler escape directive across `apps/**`, `packages/**`, `scripts/**`, root configs — `.js/.jsx/.cjs/.mjs/.ts/.tsx/.cts/.mts`. | 1.35s | **No** rule in Biome 2.5 or ESLint 10. A GritQL plugin *does* work (verified: severity `error`, category `plugin`, fails `biome check`) but covers a narrower surface — `biome.json` `files.includes` is `src`-only and omits `.mjs/.cjs/.cts/.mts` and `scripts/**`. | **KEEP** — replacement is narrower, and a Grit pattern that stops matching after a Biome upgrade reports zero, which is the BST-1220 false-green class. |
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
