# tsup clean/dts invariants — evidence

Supports `docs/agents/ci-quality.md` § "tsup clean/dts invariants" (BST-746,
BST-1014). Read this before proposing a shared tsup config factory, relaxing
the literal-`false` requirement, growing the tsup-owned exempt set, or changing
how the guard parses configs. The contract holds the rules; this file is the
record of why.

### tsup clean/dts invariants (`pnpm lint`, BST-746)

`scripts/verify-tsup-build-invariants.mjs` (alias `lint:tsup-build-invariants`,
in both the `lint` and `lint:ci` chains; guard test:
`scripts/__tests__/verify-tsup-build-invariants.test.mjs`) generalises the rule
above from `@brainstrike/agent` to every workspace package. A package whose
`build` runs `tsc -b` must not let tsup `clean` the outDir (TypeScript wrote the
`.d.ts` files into it first, and tsup's clean is not concurrency-safe against the
sibling workspace builds that concurrent app prebuilds trigger) and must not let
tsup emit declarations (the separate declaration-bundler worker duplicates
`tsc -b` and causes severe build startup contention).

BST-746 originally proposed a `createTsupConfig` factory in
`@brainstrike/build-utils`. Measured and REJECTED — do not relitigate: at that
time only 9 of 18 configs were simple, and they genuinely diverged on
`sourcemap`, `format`, `target` and `splitting`. A factory would also have added
8 build-graph edges or hit the config-load hash-gap class
`verify-config-load-hash-coverage.mjs` guards. BST-1014 resolved the ordinary
library duplication by removing tsup from those packages, not by abstracting
their obsolete configs; the eight remaining configs describe real, divergent
bundle boundaries.

The invariant is CONDITIONAL, and the class is DERIVED from each package's
`build` script rather than hand-listed. **TypeScript-owned** — `agent`,
`assistant-service`, `assistant-wire`, `embedding-worker`, and `file-explorer` —
runs `tsc -b`/`tsc --build` then tsup, and is governed. **tsup-owned** — exactly
`chunking-worker`, `file-tree-worker`, and `token-cache` — runs tsup ALONE
(`type-check` is a separate `tsc --noEmit`), so tsup is the only possible
declaration emitter and `dts: true` is REQUIRED there. A flat "every config sets
clean/dts false" rule is false for those three. The exemption carries the
INVERSE obligation (a tsup-owned package that enables no declaration emit
FAILS), so it cannot be used as a parking spot to silence a violation; a test
pins the exempt set to those three names so growing it is deliberate.

Three rulings, all enforced and all with failure-path tests:

1. **Dynamic values are rejected**, not assumed safe. Only the literal `false`
   passes; `!options.watch`, a ternary, an env read, and the non-boolean shapes
   tsup accepts (`clean?: boolean | string[]`, `dts?: boolean | string |
   DtsConfig` — every non-false value ENABLES the behaviour) all fail. The guard
   reads source text and cannot prove an expression is false at build time.
   `clean: !options.watch` is not a false positive because every config using it
   is tsup-owned; in a `tsc -b` package it SHOULD fail, since `options.watch` is
   falsy during a plain `pnpm build`.
2. **`clean` and `dts` must be STATED EXPLICITLY** in a governed config that
   exists. tsup's defaults already match, so omission is currently harmless —
   which is the problem: `text-splitter` set neither while the guard claimed all
   governed packages were "pinned", an unverified assertion (the vacuous-green
   class the discovery floors exist to prevent), and deleting `clean: false` from
   a config would have been a silent no-op. The lower-level guard still models
   config-less tsup CLI invocations so its own flag detector cannot be bypassed,
   while the canonical package-build guard rejects that third real-tree shape.
3. **Every declaration-emit spelling is modelled**, verified against the
   installed tsup 8.5.1 rather than from memory: config keys `dts` AND
   `experimentalDts`, plus four CLI flags — `--dts`, `--dts-only`,
   `--dts-resolve`, `--experimental-dts`. tsup normalises
   `if (flags.dts || flags.dtsResolve || flags.dtsOnly)`, so `--dts-only` and
   `--dts-resolve` each enable emit ON THEIR OWN; they are not modifiers of
   `--dts`. `experimentalDts` may be omitted but never enabled.

Discovery floors (`MIN_TSUP_CONFIGS` = 8,
`MIN_TYPESCRIPT_OWNED_PACKAGES` = 5) refuse to run rather than report a vacuous
green — the second catches a collapsed classification, where discovery looks
healthy but the governed class has emptied out. Config parsing is line-shaped
with comments blanked (preserving line
numbers, which are printed in the report) after normalizing Windows CRLF input
to LF; a permissive cross-check THROWS on any
guarded token the line shape did not parse, so an unmodelled shape fails loudly
instead of escaping.
