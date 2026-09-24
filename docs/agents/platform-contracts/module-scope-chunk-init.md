# Module-scope chunk initialization and the two cycle guards — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before reading an imported constant at module scope, changing `verify-mastra-schema-init-order.mjs` / `verify-no-source-cycles.mjs` / `verify-no-cross-chunk-cycles.mjs`, or "fixing" migration 066. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---

**Every probed Mastra table name must come from the canonical schema exports
(`MASTRA_MEMORY_TABLES`, `MASTRA_VECTOR_TABLE`, and
`MASTRA_WORKFLOW_TABLE`) in
`@brainstrike/assistant-contract/mastra-memory-schema`, never a hand-copied
literal.** `to_regclass` on a stale name returns NULL, which makes the probe a
PERMANENT SILENT SKIP — no error, no warn, only a `logger.debug`. Verified by
control: renaming `TABLE_WORKFLOW_SNAPSHOT` in the contract while the reset path
held an unpinned literal left a suspended-run row alive through a full clear
(`expected 1 to be +0`). Both production sites (desktop `db-ipc.ts` and renderer
`pglite-direct-transport.ts`) import the canonical exports.

The renderer used to hold a pinned local literal instead, because that import
reordered bundle chunk init and killed the app at startup. That is FIXED at the
root, not worked around — see the next rule — and the stopgap guard that pinned
the literal is deleted. Do not reintroduce a hand-copied literal here.

**Import those canonical exports freely, but read their values only inside the
function that executes the clear — never at module scope (BST-558).**
Type-position reads in the closed relation unions are erased and remain safe.
Module-scope value initializers run at bundle CHUNK
INITIALIZATION, and the renderer's chunk graph does not guarantee the contract
chunk has evaluated by then. `packages/assistant-data/src/assistant-memory-repository.ts`
used to build its bootstrap DDL in a module-scope template literal interpolating
`MASTRA_MEMORY_TABLES.threads`; adding ONE unrelated static import of
`@brainstrike/assistant-contract/mastra-memory-schema` to `db-provider.tsx`
(the renderer reset code lived there until BST-1653 moved it into
`pglite-direct-transport.ts`, where the same rule applies)
reordered chunk init and the renderer died at startup with `Cannot read
properties of undefined (reading 'threads')` — measured on PR #1978, commit
`df953a2a8` green and `3e8d1b7fd` red. The failure is not always loud: a
property access throws, but a bare interpolation such as `${MASTRA_VECTOR_TABLE}`
splices the literal string `undefined` into the DDL, and in the renderer reset
paths an undefined table name would make `to_regclass('undefined')` return NULL — the
permanent silent skip described above. Build SQL inside the function that
executes it (`buildMastraVectorSchemaSql`; and `requiredAssistantMemoryRelations`
in `assistant-memory-repository.ts`, which reads the same constants to build its
`to_regclass` probe list — the schema-mirroring builder that originally tripped
this defect was retired in BST-1651, but the rule is the reason its replacement
is a function too).

The same rule is why migration 117 carries a LITERAL copy of Mastra's memory DDL
instead of importing `MASTRA_MEMORY_SCHEMA_SQL`: `deriveCustomMigrations()` reads
every `migration.up` during module-scope evaluation of `drizzle/migrate.ts`, and
an uninitialized binding there would splice the string `undefined` into a
migration. The copy is pinned to the contract at the CATALOG level by
`packages/db/__tests__/mastra-schema-migration-parity.test.ts`.

Nothing else catches this class: `tsc` types ESM live bindings identically
either way, the schema module imports nothing so there is no source cycle to
detect, and Vitest evaluates real modules in dependency order so unit tests
always see a defined binding. Only a production build has a chunk graph.
Before the structural backstop below (BST-861) landed, E2E was the only thing
that observed it — as an unexplained startup crash. `scripts/verify-mastra-schema-init-order.mjs`
(lint lane, paired test `scripts/__tests__/verify-mastra-schema-init-order.test.mjs`)
enforces it statically instead. It scrapes the guarded names from the schema
module rather than hand-listing them, matches on the imported name so re-export
hops like `packages/agent/src/pglite-mastra-memory/sql.ts` are covered, and stops
at every function boundary so the prescribed fix is not itself flagged. It
supersedes a stopgap (`mastra-workflow-table-literal-contract.test.mjs`, deleted)
that pinned one hand-copied literal in one file and could not see `export … from`,
`await import()`, or the same import added from any other module.

**The structural backstop is an acyclic chunk graph (BST-861).** A cross-chunk
cycle is a NECESSARY PRECONDITION for the cross-chunk form of this class, not
a proxy for it: ESM evaluates a module's dependencies before its own body, so
with an acyclic chunk graph a topological init order always exists BETWEEN
chunks, and every imported binding is initialized before any cross-chunk
module-scope read of it. That is not the whole class: two source modules that
are themselves circular and land in the SAME chunk are concatenated by
rolldown in an arbitrary order, which can throw the identical
`ReferenceError` at init while the chunk graph — which has only one node for
that pair — reports no cycle. The accurate statement is "acyclic chunk graph
AND acyclic source-module graph ⇒ safe"; only the first conjunct is enforced.
The second conjunct is now enforced too (**BST-890**):
`scripts/verify-no-source-cycles.mjs` walks the renderer SOURCE graph from both
app entrypoints and fails the lint lane on any circular dependency. It needs no
build, so it lives on the lint lane rather than inside `build`.

Resolution deliberately does NOT go through tsconfig, which points
`@brainstrike/*` at `packages/*/dist/*.d.ts` and made a first attempt see only
139 modules. It composes the repo's own helpers instead — `workspaceSrcAliases`
(`packages/test-utils/workspace-src-aliases.mjs`) plus
`createAgentBrowserSafeAliasEntries`, the same pair `apps/web/vite.config.mts`
uses — and reaches 813 modules. Static, non-type imports only: `import type` is
erased and dynamic `import()` creates no init-order dependency, while a bare
side-effect `import '…'` does and is counted.

The bundler will not do this for you: a genuine source cycle planted in
`apps/web/src` built successfully, emitted ZERO rolldown circular-dependency
warnings, and left the chunk guard clean. "No circular warnings in the build
log" is a blind instrument.

On its first run this guard found a real cycle: `error-boundary.tsx`,
`theme-settings.tsx` and `theme-toggle.tsx` in `packages/ui` imported their OWN
`@brainstrike/ui` barrel, which re-exports them. **Import the sibling module
directly** — a package must never import its own barrel. That is the same
no-barrel/TDZ ruling as BST-742, and it is now enforced rather than advisory.
`scripts/verify-no-cross-chunk-cycles.mjs` asserts the first conjunct on the
emitted bundle and runs inside `apps/web`'s `build` and `apps/desktop`'s
`build:renderer`, so it cannot be bypassed by a code path that still runs the
build. It CAN be skipped by a turbo cache hit: identical inputs produce an
identical artifact, so a cached build never re-invokes the script — that is
correct, not a gap, but it means "wired into build" is not "runs on every CI
job." Measured at the time it landed: web 362 chunks / 1003 static edges / 0
cycles, desktop renderer 367 / 1036 / 0. Scope: this covers the two RENDERER
bundles only — `apps/desktop`'s `build:main` (the Electron main bundle) is
NOT covered.

The class had already recurred twice in unrelated families before this landed:
the context-action helpers (PR #1292, held today only by a `codeSplitting.groups`
entry in `apps/web/vite.config.mts`) and these schema constants. That recurrence
is why **BST-861** generalizes the INVARIANT rather than the mastra-family AST
guard above: the cycle check covers the cross-chunk form for every constant
family, including the three still held by `codeSplitting.groups` pins in both
vite configs (context-actions #1292, browser-events BST-580, zustand). Those
three pins are safe only because their underlying source-module graphs happen
to be acyclic today — nothing currently verifies that, so a future edit that
introduces a real source cycle inside one of those pinned chunks would ship
undetected. The AST guard is kept anyway because it does something the cycle
check cannot — enforce the coding rule at review time, in seconds, with a file
and line number. A repo-wide AST rule was rejected on measurement: "flag every
module-scope read of an imported binding" returns 431 hits in `app-shell` +
`db` alone, nearly all benign. The CHUNK, not the file or the package, is the
unit of risk for the cross-chunk form.

`packages/db/src/migrations/066-restore-pg-textsearch.ts` interpolates the
imported `QUALIFIED_PG_TEXTSEARCH_VERSION` into its module-scope `up` string.
**Leave it alone — do not "fix" this (BST-860, investigated 2026-07-26 and
closed won't-do).** Two reasons, both load-bearing:

1. **The obvious fix breaks production startup.** Moving `up` to the
   `MigrationCallback` form is valid for the NUMBERED runner only. Production
   runs drizzle `runMigrations`, whose ledger is SQL-string-only:
   `customMigration()` throws `must be a SQL string` for any non-string `up`
   (`packages/db/src/drizzle/migrate.ts:148-155`), and `customMigrations` is
   built at MODULE SCOPE (`:168`) — so a callback `up` throws at import time and
   every launch fails. A lazy getter does not help either: the ledger reads
   `up` at module init to hash and store the SQL. The `Migration.up` type
   accepting `string | MigrationCallback` is a property of the test runner, not
   a licence to use a callback here.
2. **The hazard is retired in the renderer.** The invariant is "acyclic chunk
   graph AND acyclic source-module graph ⇒ safe", and both conjuncts are
   enforced and clean there (`verify-no-cross-chunk-cycles.mjs` on build,
   `verify-no-source-cycles.mjs` on lint). A module-scope read is only dangerous
   when a cycle exists, so if one ever appears in the renderer, lint or build
   fails before runtime does. BST-860 predates both guards.

   Be precise about scope, because migration 066 also ships in ELECTRON MAIN:
   `src/main.ts` → `ipc-domains/db-ipc.ts` → `@brainstrike/db`. Conjunct 1 is
   not merely unenforced there, it is inapplicable — `build-main-config.mjs`
   esbuilds one file per entry, so main has no chunk graph. Conjunct 2 walks the
   two RENDERER entrypoints only, so main's source graph is unverified; what
   protects it is the ordinary bundler guarantee that an acyclic graph is
   concatenated in dependency order. Extending the source-cycle guard to the
   main entrypoints would close that, and is the cheap follow-up if this class
   ever recurs in main.

Residual risk of leaving it: negligible. Intra-package, and it fails LOUDLY —
an undefined binding yields `IF actual_version IS DISTINCT FROM 'undefined'`, so
the DO block RAISEs, unlike the silent `to_regclass('undefined')` skip that
motivated the original concern. Do not hardcode the version literal either:
that reintroduces the hand-copied-constant pattern removed in #1988 to defend
against something two guards already make unreachable.
