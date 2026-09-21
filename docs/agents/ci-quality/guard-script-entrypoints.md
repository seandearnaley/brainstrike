# Guard-script entrypoints — evidence

Supports `docs/agents/ci-quality.md` § "Guard-script entrypoint contract"
(BST-836). Read this before adding a `scripts/verify-*.mjs` guard or changing
`scripts/__tests__/verify-script-entrypoints.test.mjs`. It records the guards
that exited 0 while checking nothing and why the empty-directory money test is
the load-bearing half.

Every `scripts/verify-*.mjs` MUST run its check when executed directly and MUST
export `main({ repoRoot })`. Four of them (`verify-catalog-references`,
`verify-config-load-hash-coverage`, `verify-no-vitest-worker-mutation`,
`verify-workspace-src-aliases`) previously shipped as pure libraries with no
`main()` invocation, so `node scripts/verify-catalog-references.mjs` exited 0
while checking nothing. Control-tested: injecting a literal `"typescript":
"6.0.3"` into a package manifest — the exact drift the guard exists to catch —
still produced exit 0.

Enforcement was never missing; each guard's paired test or dedicated lint gate
asserts the real-repo verdict in the Static job. In particular, the ESLint
warning baseline's full-tree owner is `lint:ci` -> `lint:eslint`, after script
tests. The damage was evidentiary — that exit 0 was cited as proof in a PR body,
and a green from a script that cannot go red is indistinguishable from a real
one.

`scripts/__tests__/verify-script-entrypoints.test.mjs` holds the line, and its
MONEY TEST is the load-bearing half: it drives every `main()` against an empty
directory and fails any that report success. A `function main() {}` no-op
satisfies the static "has an entrypoint" check while reproducing the bug exactly,
as does a `main()` that accepts `repoRoot` and ignores it — both are covered.
The real child-process probe also covers direct-execution detection. Expensive
entrypoints may use an explicit bounded invalid root there when the owning gate
already retains the full-repository verdict; that bounded probe must require its
fixture-specific failure output and a nonzero exit.

Consequences when adding a guard: thread `repoRoot` through to the check rather
than closing over a module-level constant, and make the CLI's verdict identical
to the paired test's (e.g. `verify-workspace-src-aliases`'s `main` passes
`appsRoot` explicitly because the CI-wired test does — a CLI checking a narrower
tree than CI is a second, weaker verdict wearing the same name).

`verify-tokenizer-asset-bundle` and `verify-no-cross-chunk-cycles` are the
shape exceptions: each inspects a build artifact, so it takes a bundle
`directory` instead of a repo root.
