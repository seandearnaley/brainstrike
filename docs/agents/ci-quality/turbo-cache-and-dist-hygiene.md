# Root clean, worktree-scoped Turbo caches, and stale-dist pruning — evidence

Supports `docs/agents/ci-quality.md` §§ "Root clean orchestration",
"Worktree-scoped local Turbo caches" (BST-1312), and "Stale-dist pruning before
non-cleaning tsc builds" (2026-07-30 cache poisoning, BST-1014). Read this
before changing where the Turbo wrapper keeps its local cache, collapsing
worktree namespaces, replacing a prune with a clean (or the reverse), or
enabling tsup code-splitting in a pruned package.

### Root clean orchestration

The root `pnpm clean` command stays on the shared Turbo command wrapper so it
retains the same grouped logs and run summary as the other root graph commands.
The root `clean` task is uncached, declares no outputs, and has no dependency
edges. Every workspace package with a `build` script must declare `clean`;
TypeScript and app packages remove local `dist`/`.tsbuildinfo`, while native
addon packages remove their local node-gyp `build` directory. The command,
complete build-package coverage, and resolved task graph are guarded by
`scripts/__tests__/package-scripts-canonical-form-contract.test.mjs`.
That test invokes Turbo's JavaScript entrypoint through `process.execPath`;
do not execute the generated `turbo.cmd` shim directly, because Node 24 rejects
batch files passed to `execFileSync` on Windows.

### Worktree-scoped local Turbo caches (BST-1312)

The bounded Turbo wrapper's default local cache remains outside the checkout,
but it is scoped by the canonical Git worktree root under the platform cache
home (`.../BrainStrike/turbo/worktrees/<name>-<path-hash>`). Package-level and
root invocations in one worktree therefore share one cache and nested-run lock;
different worktrees do not share local cache sidecars. Explicit
`TURBO_CACHE_DIR` / `BRAINSTRIKE_TURBO_CACHE_DIR` values remain exact operator
overrides and are not silently rewritten. Invocations outside a Git worktree
must set one of those overrides; the wrapper fails loudly rather than silently
returning to the unsafe machine-global default. Turbo's `--cwd` value, when
present, owns worktree resolution rather than the wrapper process directory.

This isolation is a correctness boundary for Turbo 2.10's restore manifests,
not a response to `.tsbuildinfo` restoration or cache pruning. A deterministic
two-worktree reproduction created different four-byte outputs with identical
mtime, size, and mode. Both worktrees wrote the same HOME-level cache before
one selected the other's task hash. Turbo's `<hash>-manifest.json` records only
path plus size/mtime/mode and is stored beside the shared archive; it contains
neither output bytes nor checkout identity. The second worktree therefore
reported a cache hit while retaining the first worktree's wrong bytes. The
25-GiB prune was below its cap and did not participate.

Scoping deliberately gives up machine-local hits between worktrees because the
metadata-only sidecar makes those hits unsafe. It preserves local hits across
commands and branch changes within one worktree, and Turbo's independently
configured remote cache remains shareable across worktrees and machines. It
does not change Turbo's metadata-only identity inside one worktree: switching
between two previously cached hashes can still retain same-size/same-mtime stale
bytes in that one namespace. That residual, non-concurrent case is outside the
cross-worktree failure fixed here and must not be described as content-safe.

The scoping also confines the wrapper's post-run pruning and nested-run lock to
the active worktree, so one interrupted or maintained lane cannot remove or
block another lane's usable local entries. The 25-GiB limit consequently applies
per active worktree, not machine-wide; removed worktrees and the pre-BST-1312
top-level cache are not automatically collected. Operators should remove those
abandoned directories as part of worktree/cache housekeeping. Automatic
cross-namespace collection is intentionally deferred because deleting a
namespace without an active-lane lease would reintroduce the cross-lane
invalidation this boundary prevents. Do not collapse these directories back
into one HOME-level cache unless Turbo's restore identity becomes content- or
checkout-aware and the paired same-size/same-mtime concurrency regression proves
the shared topology safe.

### Stale-dist pruning before non-cleaning tsc builds (2026-07-30 cache poisoning)

tsc's incremental builder never deletes outputs whose sources are gone, and the
nested Turbo run by apps/web + apps/desktop `prebuild`/`predev`
(`scripts/run-turbo-command.mjs`) snapshots each package's whole `dist/**` into
the wrapper's cache (the machine-global `~/Library/Caches/BrainStrike/turbo` at
the time of this incident; worktree-scoped after BST-1312). A branch switch that
deletes sources therefore leaves orphaned compiled files in `dist`,
and the next cache save immortalizes them: cold runs restore the poisoned
archive verbatim even after local deletion, tripping `turbo boundaries`
(2026-07-30 incident: 16 boundary issues, 125 poisoned archives purged).

The guard: every build-chain script (`build`, `prebuild`, `postbuild`,
`build:*`) that runs an emitting tsc (any form without `--noEmit` — `-b`,
`--build`, `--project ... --emitDeclarationOnly`, bare `tsc`) must either
clean `dist` first or prepend `node <depth>/scripts/prune-stale-dist.mjs`.
The pruner resolves the package's real tsc program (tsconfig
extends/include/exclude respected, via the TypeScript config loader) and
deletes dist artifacts no program source would emit. Program membership — not
filesystem existence — is the orphan test: a `dist/foo.test.js` whose
`src/foo.test.ts` still exists but is tsconfig-excluded is an orphan (most
wired packages exclude `**/*.test.*`, and compiled tests import vitest — the
exact `turbo boundaries` shape). Two carve-outs: outputs of on-disk
`.js`/`.jsx` sources outside the program are kept (bundler entries like
file-explorer's `.worker.js`), and `.json` pruning activates only when the
program itself contains json sources (db's `drizzle/migrations.json`) — a
generated dist json (a `{"type":"commonjs"}` marker, a copied manifest) is
produced, not compiled, and deleting it would not self-heal. Residual class,
accepted: a generated dist json inside a json-compiling package.

Pruning — not cleaning — is deliberate for the wired packages: it preserves
incremental builds, and it is safe under concurrent builds of the same package
(the reason agent's tsup pins `clean: false`) because a concurrent build only
emits files whose sources are in the current program, so the prune set is
disjoint from its writes. That disjointness silently depends on tsup NOT
code-splitting (hashed split chunks have no source counterpart and would be
pruned out from under a sibling build), so the wiring contract statically
requires `splitting: false` in every pruned package's tsup config. After
BST-1014, `agent` and `file-explorer` are the complete live intersection of
pruned packages and real bundle boundaries; the paired test pins its
anti-vacuity floor to both while continuing to discover and inspect every future
intersection member. The pruner
itself requires `tsconfig.json` with rootDir `src` and outDir `dist` and
per-file emit — anything else throws, and such a package must clean instead. `ui`'s
`pnpm run clean:generated` cleans stray compiled JS in `src`, not `dist` — it
does not satisfy this contract (ui's `dist/prompt-management` was a proven
poisoning vector behind exactly that prefix). The contract scans build-chain
scripts only: `type-check`'s emitting `tsc --build --force` (apps/web) cannot
create orphans or archives — only `build` has `dist/**` outputs, and the prune
before every snapshot-producing build launders dist before archiving. The
wiring contract, pruner behavior, entrypoint controls, and the `turbo.jsonc`
`global.inputs` hash entry for the pruner (editing it must invalidate
cached builds) are guarded by `scripts/__tests__/prune-stale-dist.test.mjs`.
