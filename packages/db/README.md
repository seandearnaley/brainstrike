# @brainstrike/db

PGlite is PostgreSQL compiled to WASM, not SQLite. This package supplies its
schema construction, repositories, search and durable embedding-job queue for
remaining web and explicit test/conformance consumers. Desktop canonical state
belongs to the host StateStore and committed log; its derived index is SQLite.
See the [database contract](../../docs/agents/database.md).

## Public boundaries

The root entry is React-free. React consumers import `DbProvider` and its hooks
from `@brainstrike/db/react`; `DbProvider` is not a root export. The provider owns
one database runtime per mount, so changing its initialization props does not
replace the live database. Current desktop UI does not wrap itself in this
PGlite provider or expose the old renderer SQL bridge.

The provider's default path comes from
[`default-db-path.ts`](src/default-db-path.ts) and
[`browser-pglite-storage.ts`](src/browser-pglite-storage.ts). It is not a fixed
cross-platform `app.db` convention; explicit qualification profiles supply their
own owned path.

## Engine construction and schema

Use the shared qualified factory rather than a bare `new PGlite`:

```ts
import { migrate } from '@brainstrike/db';
import { createBrainstrikePglite } from '@brainstrike/db/pglite-factory';

const db = await createBrainstrikePglite({ dataDir: 'memory://' });
try {
  await migrate(db);
  // Use this disposable database through its existing repository/queue owners.
} finally {
  await db.close();
}
```

`createBrainstrikePglite` loads the full engine extensions and live client plugin.
`createEnginePglite` omits the client plugin for worker-hosted engines. The
verification factory adds its qualified verification extension and has a separate
restricted import boundary. Extensions and construction options live in
[`pglite-factory.ts`](src/pglite-factory.ts).

The migration registry and ledger keys construct the current schema. Their
presence does not require old-data imports or populated legacy upgrade gates;
[ADR-0020](../../docs/adr/0020-greenfield-data-lifecycle.md) governs that scope.
PGlite has one connection: retain its existing scheduler/transaction and
subscription-drain lifecycle. `statement_timeout` does not stop WASM work.

## Owned surfaces

Queue, managed cache, migrations, repositories, search and schema have dedicated
barrels under `src/`. Extend the owning surface before re-exporting through the
root facade. Durable job payloads carry producer-owned source/input identity;
queue retries do not authorize duplicate publication or stale vector writes.
These PGlite APIs do not define desktop StateStore or native-index behavior.

## Development

Use the scripts in [`package.json`](package.json), including `build`, `type-check`,
`test` and `test:browser`. Declare local dependencies with `workspace:*`.
**CI is disabled due to cost; validation must run locally.** Follow
[validation guidance](../../docs/agents/ci-quality.md).
