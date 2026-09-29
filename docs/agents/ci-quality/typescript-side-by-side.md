# TypeScript 7 CLI with the TypeScript 6 compatibility API — evidence

Supports `docs/agents/ci-quality.md` § "TypeScript 7 CLI with the TypeScript 6
compatibility API" (BST-1011). Read this before bumping either compiler pin,
changing which package owns the `tsc` bin, or touching desktop's packaged
TypeScript dependency. Adoption evidence and reproduction commands:
`docs/series-c-ts7-parity-findings.md`.

Added at extraction: the catalog also carries a third alias, `@typescript/old`
(`npm:typescript@6.0.3`) — the concrete TypeScript 6 implementation that gives
the editor a stable TSDK and that desktop ships for its LSP. It is "the concrete
TypeScript 6 implementation" the packaging paragraph below refers to, and the
wiring test pins it alongside the other two.

All bare `tsc` commands use the TypeScript 7 native compiler. The catalog's
`@typescript/native` alias installs `typescript@7.0.2` at the root and owns the
`tsc` bin. The catalog's existing `typescript` name resolves to the official
`@typescript/typescript6@6.0.2` compatibility package: it owns `tsc6` and the
classic programmatic API, but deliberately does not own `tsc`. This is the
TypeScript team's supported side-by-side topology; do not replace it with two
aliases of the ordinary `typescript` package, which recreate an ambiguous bin.

Repository scripts, ESLint, Stryker, DB compiler tests, and the desktop
runtime-host boundary import `typescript` as a library and must continue to
resolve major 6. Type-check/build scripts execute `tsc` and must resolve major
7 from both root and package scope. `scripts/__tests__/typescript-compiler-wiring.test.mjs`
derives both the type-check-package and API-consumer sets dynamically, applies
anti-vacuity floors, checks the installed package/bin identities, and executes
both compilers. API-consumer discovery comes from `git ls-files`, so ignored
build/coverage output cannot change the census between a developer tree and CI;
an unresolvable consumer is reported as a violation instead of crashing test
module initialization, and workspace-state collection is lazy so failures occur
inside a named test. Package-manager subprocesses use the repository's
cross-platform spawn helper; do not call extensionless `.bin` shims directly.
Its mutation controls prove a swapped major, a native API consumer, an
unresolvable consumer, a compiler patch bump without renewed parity evidence,
editor TSDK drift, or a compatibility package shadowing `tsc` all fail loudly.
The complete wiring file costs about 1.4 seconds locally (seven tests, including
three compiler-version subprocesses) inside the roughly 14-second script-test
phase; keep that cost explicit if more process probes are added.

Desktop packaging is a separate boundary from workspace module resolution.
`apps/desktop/src/__tests__/build-main-config.test.ts` requires the concrete
TypeScript 6 implementation to be a production dependency and requires its
Electron Builder unpack rule. Its mutation control removes both seams and
asserts the exact violations, preventing a source-tree-only LSP green from
hiding a packaged-app failure.

`scripts/ts7-parity-check.mjs` compares every discoverable `--noEmit` command
under `tsc6` and `tsc`, checking binary majors before discovery. It deliberately
does not claim parity for `apps/web`'s emitting `tsc --build --force`; that path
must be verified in a clean isolated worktree so one compiler's declarations
cannot affect the other. The adoption evidence and reproduction commands live
in `docs/series-c-ts7-parity-findings.md`.
