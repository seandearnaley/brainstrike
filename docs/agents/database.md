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
