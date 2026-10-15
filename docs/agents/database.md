# Database and catalog boundaries

## Desktop ownership

The existing agent-host StateStore owns canonical roots, source records, model
choices, collections, prompts, groups, presets and worktree metadata. The committed
host log owns conversations, runs, decisions, usage and workspace bindings.
Derived indexes are separate owners. Desktop does not construct PGlite or expose
a renderer SQL/live-query compatibility bridge.

Both desktop-first and CLI-first clients borrow the catalog through the same
authenticated host attachment. Authenticate before registering catalog endpoints;
drain admitted operations before retiring their writer. This grants no additional
desktop credential or MCP privilege. Root descriptors carry canonical identity;
renderer paths do not establish ownership.

## Catalog and schema

The provider catalog is the source of static model metadata; user choices are
separate. Keep its runtime schema, supported consumers and current-schema creation
consistent. Surviving PGlite catalog changes use the migration registry and its
ledger keys; the Drizzle ledger is derived. Do not invent legacy-data conversion
or populated old-schema gates: [ADR-0020](../adr/0020-greenfield-data-lifecycle.md)
governs greenfield scope.

Updating only the static catalog is NOT enough — the in-app model picker is driven
by a DB-backed catalog, so a catalog change is a two-part edit. The single source
of truth to edit is:

   - packages/assistant-contract/src/provider-catalog.json

The catalog is DATA, not a TypeScript literal.
`scripts/model-catalog-migration-contract.mjs` and the provider env-keys mirror contract read it with `JSON.parse`,
so no catalog field may reference a constant; comments are optional `_note`
strings that `parseProviderCatalog` strips. `tsc` does not check catalog rows,
because JSON widens under `resolveJsonModule`:
`packages/assistant-contract/src/provider-catalog-schema.ts` does, at module load, and THROWS.
Every object is a Zod `strictObject`, so an unknown or misspelled key fails
rather than being dropped, and adding or retyping a field means editing the
schema AND the interface in the same change. Catalog row changes that must
survive in PGlite still need a numbered migration carrying its `ledgerKey`.

`packages/db/src/migrations/current-schema.sql` is the whole schema in one step,
GENERATED from a database the real chain built (`pnpm --filter @brainstrike/db
db:schema:ddl`) and never transcribed from migration sources. It is not applied
at boot yet; production still replays the chain. Its equivalence is enforced by
`current-schema-ddl-equivalence.integration.test.ts`, which boots both from
initdb and compares catalog readback: relations, columns, constraints, indexes
and their access methods and parameters, sequences, extensions, generated
columns, and the seeded catalog rows. Adding a migration therefore requires
regenerating that file. The only values exempted from the row comparison are
columns whose DEFAULT is non-IMMUTABLE per `pg_proc` (the clock, `uuidv7()`);
the seed leaves those to fire at install time, exactly as the chain's own seeds
do.

## Remaining PGlite consumers

Web and explicit test/conformance paths retain PGlite. Each construction loads the
shared qualified engine extensions, with live-query support only where required.
Keep the engine family compatible through its existing package catalog and
compatibility check; a partial version change must not bypass that check.

PGlite is one connection. Admit multi-statement operations through its existing
scheduler/atomic transaction primitive. Drain statements and live subscriptions
before close, reset or replacement. `statement_timeout` does not bound WASM work;
neither a timer nor an AbortSignal proves a synchronous statement stopped. A
poisoned engine fails visibly and is not repeatedly reopened.

Browser first-run bootstrap applies only to a missing store. It becomes complete
only after the strict persistent instance's awaited flush and existence check;
interrupted-bootstrap cleanup cannot delete a completed user store.

## Data loss boundaries

Durability classification determines repair and export policy. Precious state and
schema ledgers are never automatically truncated; derived data needs a real
rebuild owner. A cascade must not turn derived repair into canonical data loss.
Unknown classification or corruption refuses rather than guessing or deleting.

Clear removes content/grants/derived indexes while retaining configuration;
Factory Reset clears configuration too. Both use the existing retirement and reset
owners. See [StateStore](state-store.md) and [platform](platform-contracts.md).

Implementation: `packages/db`, `packages/assistant-contract`, `packages/state-store`
and `packages/agent-host`.
