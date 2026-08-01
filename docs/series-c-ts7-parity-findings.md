# Series C — TypeScript 7 native adoption evidence

**Current outcome: adoption candidate is locally green.** The workspace uses
TypeScript 7.0.2's native `tsc` for command-line checking while retaining the
TypeScript 6 compatibility package for every classic compiler-API consumer.
Required external CI timing and review still decide whether this candidate
lands; this document does not claim a workflow saving before that evidence.

This replaces the July 2026 findings-only conclusion. That earlier conclusion
was correct for its revision, but its two blockers have since changed:

- TypeScript now documents an official side-by-side package topology whose
  compatibility compiler exposes `tsc6`, avoiding the old alias/bin collision.
- BST-584 moved Electron main-process checking from removed `node10` resolution
  to `module: preserve` + `moduleResolution: bundler`; esbuild owns the CJS
  runtime bundle. The former TS5108 blocker no longer exists on `main`.

## Installed topology

TypeScript 7.0.2 is the stable native compiler. It intentionally does not
provide the classic programmatic TypeScript API in 7.0, so the workspace uses
the side-by-side installation documented by the TypeScript team:

```json
{
  "typescript": "npm:@typescript/typescript6@6.0.2",
  "@typescript/native": "npm:typescript@7.0.2"
}
```

The dependency names have distinct responsibilities:

| resolved dependency | executable/API | responsibility |
| --- | --- | --- |
| `@typescript/native` → `typescript@7.0.2` | `tsc`; version 7.0.2 | all package `type-check` and emitting `tsc` commands |
| `typescript` → `@typescript/typescript6@6.0.2` | `tsc6`; classic API reports 6.0.3 | ESLint, Stryker, repository scripts, and runtime/test compiler-API imports |

The compatibility package's published package version and its embedded
compiler's reported version differ by one patch (`6.0.2` package, `6.0.3`
`tsc6`/API). The contract therefore pins the package identity and checks the
compiler **major**, rather than claiming those two patch strings are equal.

The root declares `@typescript/native: catalog:`. Existing package-level
`typescript: catalog:` declarations now resolve the compatibility library,
whose only compiler bin is `tsc6`; it does not shadow `tsc`. Consequently bare
`tsc` commands resolve the native root executable, while imports from
`typescript` continue to resolve the classic API.

`scripts/__tests__/typescript-compiler-wiring.test.mjs` is the fail-loud
contract. It verifies the two catalog aliases and package bin shapes, executes
root `tsc` and `tsc6`, executes `tsc` from package scope, dynamically discovers
classic API imports, and proves all of them resolve major 6. Its controls
mutate compiler majors, API resolution, and the compatibility bin shape and
observe the expected failures. Discovery floors protect both the type-check
package sweep and API-consumer sweep from becoming empty.

## Diagnostic parity

`scripts/ts7-parity-check.mjs` remains the diagnostic comparator. It discovers
workspace `type-check` scripts, follows same-package `pnpm` script chains,
classifies every command, and compares normalized diagnostic identity plus
success/failure class under both compilers. It now defaults to the checked-in
side-by-side shims:

```sh
node scripts/ts7-parity-check.mjs
# TS6: node_modules/.bin/tsc6
# TS7: node_modules/.bin/tsc
```

Explicit `--ts6-bin` / `--ts7-bin` paths remain available for future compiler
probes. Both binaries' majors are checked before discovery; comparing one
compiler against itself cannot report parity.

### Pre-fix sweep

The full sweep against the current package graph produced:

- 75 matched `--noEmit` invocations
- 2 mismatches, both the same `packages/embeddings/src/device-detection.ts`
  TS2430 diagnostic (main and test configs)
- 1 explicitly uncompared build-mode command (`apps/web`'s
  `tsc --build --force`)
- 2 out-of-scope native-addon `node --check` commands
- summed sequential time: TS6 91.4s, TS7 18.4s, or 4.96×

The only diagnostic divergence was a genuinely unsound global augmentation:
the source redeclared `Navigator.gpu` as optional and narrower than the DOM
library's required `NavigatorGPU.gpu: GPU`. TS6 attributed that conflict to
`lib.dom.d.ts`, where `skipLibCheck` hid it; TS7 attributed it to the source
augmentation and surfaced it.

The fix removes hand-written WebGPU replacements already supplied by
`lib.dom.d.ts`, uses the platform `GPU` type, and augments only the two legacy
optional `GPUAdapter` members this module probes. Both the main and test
embeddings projects then check clean under both compilers. This is a soundness
fix, not a suppression or relaxed setting.

After that fix the full re-run matched all 77 comparable invocations with zero
mismatches and zero compiler errors. Its summed sequential time was 100.6s for
TS6 and 16.3s for TS7 (6.17×). The script still refuses to print
`PARITY HOLDS` because it deliberately treats the web build-mode command as
unverified. That is not papered over; declaration emit was verified separately
in an isolated clean worktree.

## Build-mode and declaration evidence

`apps/web` starts `type-check` with `tsc --build --force`. Build mode writes
project outputs, so running TS6 and TS7 in place would let the first compiler's
artifacts affect the second. `--build --noEmit` is not a substitute: referenced
projects reject it with TS6310. The comparison therefore used a disposable git
worktree and cleaned outputs between compilers.

Evidence from the isolated worktree:

1. After the normal Turbo build prerequisite, TS6
   `apps/web tsc --build --force` passed in 26.63s.
2. A clean TS7 build initially exposed one real graph defect: `packages/ui`
   imports `@brainstrike/hooks` and declares the workspace dependency, but its
   composite project omitted the `../hooks` project reference. A warm rerun was
   green because the missing dependency declaration happened to exist by then;
   that is the same ordering-dependent false-green class this work is meant to
   eliminate.
3. Adding the missing project reference made `tsc --build --clean` followed by
   TS7 `tsc --build --force` pass from a clean state in 3.11s.
4. A zero-Turbo-cache `pnpm type-check` then passed all 88 build/type-check
   tasks in 55.181s (55.81s process wall-clock).

TS7 and TS6 declaration files are not byte-identical: 445 of 3,076 generated
`.d.ts`/map files differed in quoting or ordering. Sampled differences were
semantically equivalent, and the complete consumer graph type-check/build
passed. This evidence supports semantic compatibility; it does not claim byte
parity.

The new UI→hooks reference is also validated by the existing
`tsconfig-global-deps-contract` rule: every cross-package project reference
must have a matching workspace dependency, ensuring Turbo carries the config
edge in its build graph.

## Classic TypeScript API consumers

TypeScript 7.0 has no stable classic compiler API, so all imports from
`typescript` must remain on the compatibility package. Do not maintain a
hand-written allowlist: the wiring contract derives the census from the source
tree on every run and requires at least eight consumers.

At adoption time the dynamically derived consumers include repository
architecture/migration/Playwright scripts, two DB compiler tests, and the
desktop runtime-host boundary parser. Each resolves `typescript.version` major
6 from its own package scope. ESLint and Stryker likewise retain their classic
API through the same catalog alias.

The important invariant is the name split:

- **execute `tsc`** for the native compiler;
- **execute `tsc6`** only for parity/reference measurements;
- **import `typescript`** for the classic compatibility API;
- never import `@typescript/native` as a library.

## Timing interpretation

The sequential parity ratio is a useful compiler signal, not a CI prediction.
The full cold local Turbo run includes build prerequisites, graph scheduling,
and package process startup, while CI uses different hardware and contention.
Required external timing must therefore compare the Turbo `type-check` phase on
a PR that actually changes the compiler wiring. Job duration alone is too
coarse because setup and unrelated phases can dominate.

No TypeScript checker-count flag is added in this slice. TS7's published
default is `--checkers 4`, so the unflagged command is already the parallel
baseline. It is used and measured first; tuning concurrency without evidence
would combine two variables and make the result harder to attribute.

## Reproduction checklist

Use Node 24 and a clean install:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --version
pnpm exec tsc6 --version
node -e "console.log(require('typescript').version)"
node --test scripts/__tests__/typescript-compiler-wiring.test.mjs
node scripts/ts7-parity-check.mjs
pnpm type-check
```

Expected identities are native major 7, compatibility/API major 6. The parity
script is expected to return non-zero only because it names the isolated web
build-mode command as not compared; any diagnostic mismatch or compiler error
is a stop condition. Use an isolated clean worktree for the web build-mode
proof, then run the repository's full same-run gate before pushing.

## Review gate

This candidate is acceptable only if all of the following remain true:

- no diagnostic divergence under the dual-compiler comparator;
- clean TS7 web build-mode/declaration emit succeeds in isolation;
- all discovered classic API consumers resolve major 6;
- the full build, lint, type-check, unit, integration, browser, and E2E battery
  is green in one run;
- required external CI demonstrates no type-check or workflow wall-clock
  regression, using phase summaries rather than estimates;
- independent review has examined the package aliases, API resolution, missing
  project-reference fix, and false-green controls.

If any compiler identity cannot be resolved or parsed, the guards fail. There
is no fallback from native `tsc` to compatibility `tsc6`, and no code path that
silently treats an unverified build-mode command as parity.
