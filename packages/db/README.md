# @brainstrike/db

Utilities for working with a local SQLite database powered by PGlite. The package exposes migration helpers, repositories for file/embedding data, and a durable JobQueue used by the embedding worker.

## Installation

This package is internal to the monorepo and should be linked via pnpm workspaces.

```bash
# Add to a specific workspace (example: apps/desktop)
pnpm add @brainstrike/db --filter @brainstrike/desktop

# Or declare it manually inside the target package.json
"dependencies": {
  "@brainstrike/db": "workspace:*"
}
```

## Usage

### DbProvider

`DbProvider` is exported from `@brainstrike/db` and creates a `PGlite` database
using the provided `dbPath`. If `dbPath` is not supplied, the provider detects
the runtime (`typeof window === 'undefined'`) and defaults to `app.db` for
Node/Electron or `idb://app` for browsers. It exposes a `FileRecordRepository`
via `useFileRecordRepository`. Both the web (`apps/web`) and desktop
(`apps/desktop`) applications wrap their root components in this provider.

```tsx
import React from 'react';
import { DbProvider, migrate, useFileRecordRepository } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';

// Run migrations before rendering the app
const db = new PGlite('app.db');
await migrate(db);

export function Root() {
  return (
    <DbProvider>
      <MyComponent />
    </DbProvider>
  );
}

function MyComponent() {
  const repo = useFileRecordRepository();
  // ...
}
```

### FileRecordRepository

```ts
const db = new PGlite('memory://');
await migrate(db);
const repo = new FileRecordRepository(db);

await repo.create({
  id: '1',
  name: 'demo.txt',
  path: '/tmp/demo.txt',
  size: 42,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const all = await repo.findAll();
```

### JobQueue (Durable)

```ts
import { JobQueue } from '@brainstrike/db';

const queue = new JobQueue(db);

await queue.enqueue({
  queue: 'embeddings',
  jobType: 'embed_chunk',
  payload: {
    chunkId: 'chunk-123',
    embeddingSetId: 'set-abc',
    modelKey: 'openai::text-embedding-3-small',
  },
  dedupeKey: 'embed:chunk-123:set-abc:openai::text-embedding-3-small',
});
```

### Embedding Cache (Optional)

The `embedding_cache` table supports content-level deduplication. Use the Drizzle repository to read/write cache entries and inject it into `startEmbeddingWorker({ embeddingCache })`.

```ts
import { DrizzleEmbeddingCacheRepository } from '@brainstrike/db';

const cacheRepo = new DrizzleEmbeddingCacheRepository(db);
const hit = await cacheRepo.get(contentHash, modelKey);
```

## Migrations and Database Path

Run migrations after creating a `PGlite` instance. The path passed to `PGlite` determines where the database is stored. When using `DbProvider` without a
`dbPath` prop, it will automatically choose `app.db` in Node/Electron or
`idb://app` in the browser.

```ts
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '@brainstrike/db';

const db = new PGlite('my.db'); // use 'memory://' for ephemeral or 'idb://db' for IndexedDB
await migrate(db);
```

### Bootstrap Capability Probe

The bootstrap capability probe is a migration-planning diagnostic for the
current PGlite runtime. It opens an isolated store, runs the production
migrations, and emits an explicit report for the database behaviors that a
future Turso/libSQL runtime must preserve. The current PGlite implementation
uses PostgreSQL-specific surfaces such as pgvector and pg_trgm, but a Turso
runtime only needs equivalent application behavior: store open/close lifecycle,
vector retrieval, grep prefiltering, transactions, reactive query updates,
durable queue tables, assistant run-usage storage, and workspace indexing
schema.

```bash
pnpm --filter @brainstrike/db bootstrap:capability-probe -- --format json --out /tmp/brainstrike-bootstrap-probe.json
pnpm --filter @brainstrike/db bootstrap:capability-probe -- --format markdown --out /tmp/brainstrike-bootstrap-probe.md
```

The command exits non-zero when any required check fails. The Mastra memory
schema check is intentionally reported as optional because those tables are
initialized by the app-shell/agent memory runtime rather than the DB migration
baseline.

### Runtime selection seam

`src/architecture/db-runtime-selection.ts` is the fail-closed selector for the
PGlite-to-Turso migration. It keeps the current defaults in place
(desktop/filesystem PGlite, web/IndexedDB PGlite, node-test/memory PGlite),
preserves caller source provenance for diagnostics, allows an explicit Turso
runtime only on desktop, and rejects unknown runtime strings instead of silently
degrading to PGlite. Turso support here means equivalent Brainstrike application
behavior, not PostgreSQL extension parity; web and node-test stay on PGlite until
they have supported runtime adapters with the same DB client contract.

## Domain Ownership

`@brainstrike/db` is an infrastructure package. The root public API should stay
as a compatibility facade over owned internal surfaces:

- `src/queue/index.ts` owns durable job queue exports.
- `src/managed-cache/index.ts` owns managed embedding-cache mutation exports.
- `src/migrations/index.ts` and `src/migrations/bootstrap.ts` own migration
  ordering, bootstrap behavior, and migration runner contracts.
- `src/repositories/index.ts` owns repository constructors, interfaces, and
  raw-SQL/Drizzle implementation exports.
- `src/search/index.ts` owns hybrid-search and RRF exports.
- `src/schema/index.ts` owns Drizzle schema table/type exports.

Do not add new root exports by reaching directly into implementation files when
an owned barrel exists. Add or update the owning barrel first, then re-export
from `src/index.ts` if compatibility requires it.

Focused local verification:

```bash
pnpm --filter @brainstrike/db exec vitest run __tests__/architecture-ownership.test.ts
pnpm --filter @brainstrike/db type-check
```

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
