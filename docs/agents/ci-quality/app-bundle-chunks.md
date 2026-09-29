# App bundle chunks, tokenizer asset, worker entry, and eval warnings — evidence

Supports `docs/agents/ci-quality.md` § "App bundle chunk ceiling and tokenizer
asset". Read this before raising the chunk ceiling, moving the `o200k_base`
table, changing worker bundle topology, touching web entry/Zod configuration
order, or widening the Rolldown `EVAL` warning filter. The contract holds the
rules; this file is the record of why.

Status today (appended): the filter's PGlite pattern is still pinned to 0.5.3
while the `@electric-sql/pglite` catalog pin has moved on (0.5.8), so that
pattern matches nothing and PGlite `EVAL` warnings surface in every app build.
That is the intended fail-visible state, recorded in
`packages/build-utils/src/vite.ts`; bumping the pattern requires redoing the
production-CSP qualification. The web-tree-sitter 0.25.10 pattern still matches
the installed version.

### App bundle chunk ceiling and tokenizer asset

Both app Vite builds use a 1,300 kB JavaScript chunk warning ceiling. This
accepts the measured local-first worker runtimes (browser bootstrap, PGlite,
and Transformers) plus the current renderer/main, context-preview, and
workspace-sync entry chunks while preserving a warning for growth beyond the
largest reviewed output. Do not raise the ceiling to accommodate tokenizer
data.

The browser `o200k_base` table is resolved through Vite's `?url` asset contract
and fetched only when an accurate-token-counting worker first initializes.
Keep the table out of JavaScript chunks and out of both apps' initial HTML
module-preload closure. Heuristic counting must not fetch the table. The
runtime behavior and both app ceilings are pinned by the tokenization package's
strict-counter/worker-lite tests and app Vite-config tests.

`@brainstrike/tokenization` is an ordinary tsc-only library and the sole source
owner. Its root exposes only synchronous constants, heuristics, and cost helpers;
its only public subpaths are the strict-counter and worker-lite modules that have
real consumers. Importing the root cannot pull tokenizer assets into an eager
graph. `chunking-worker` and `token-cache` bundle those shared entrypoints into
their own isolated artifacts; neither owns a source shim or imports the other
worker package.

The `chunking-worker` and `token-cache` tsup builds must install the shared
`tokenizerAssetPlugin` so their published worker artifacts preserve that URL
contract instead of parsing the table into JavaScript. Both package build
scripts run `verify-tokenizer-asset-bundle.mjs`; do not remove that post-build
guard when changing their bundle topology.

Both app worker builds install `preserveWorkerEntryPlugin`. Vite's worker
bundler options force `preserveEntrySignatures: false`; the bundler options hook
restores a strict entry facade. Without that facade, a lazy CommonJS dependency
can import worker startup from its own entry chunk without the managed instance
URL fragment and initialize it twice. The real Vite build regression executes
both the broken stock output and the preserved-entry output. Production web
also configures Zod's public `jitless` option in its small entry module before
dynamically configuring the host capability and then importing the application.
The previous static configuration module was bundled with application schemas,
whose initialization ran before configuration; this is a compiled chunk-ordering
failure, not a general claim about ESM dependency evaluation. The compiled
strict-CSP test is the ordering guard. `jitless` disables Zod parse code generation
in the window realm, preserving strict CSP at the cost of that optimization;
worker realms remain separate and their real startup/embedding paths must pass
the same CSP qualification before changing their schema initialization.

Both app builds install the shared
`createCspQualifiedEvalWarningFilter`. It suppresses Rolldown's `EVAL` warning
only for the exact web-tree-sitter 0.25.10 and PGlite 0.5.3 files whose real
runtime paths were exercised under the production CSP without `unsafe-eval`
(BST-573/594). The package versions and PGlite chunk filename are intentionally
pinned: an upgrade, a new emitted module, a different warning code, or an eval
from any other dependency must surface normally and require fresh review.
Never replace this with a code-only or package-wide warning suppression.
