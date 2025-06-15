# @brainstrike/db

Utilities for working with a local SQLite database powered by PGlite. The package exposes migration helpers and a repository for managing file metadata.

## Installation

This package is internal to the monorepo and consumed via workspace linking.

```bash
# From the project root
pnpm add @brainstrike/db
```

## Usage

### DbProvider

`DbProvider` is exported from `@brainstrike/db` and creates a `PGlite` database
using the provided `dbPath`. It exposes a `FileRecordRepository` via
`useFileRecordRepository`. Both the web (`apps/web`) and desktop (`apps/desktop`)
applications wrap their root components in this provider.

```tsx
import React from 'react';
import { DbProvider, migrate, useFileRecordRepository } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';

// Run migrations before rendering the app
const db = new PGlite('app.db');
await migrate(db);

export function Root() {
  // DbProvider will close the database on unmount once implemented
  return (
    <DbProvider dbPath="app.db">
      {/* application components */}
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
const db = new PGlite(':memory:');
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

## Migrations and Database Path

Run migrations after creating a `PGlite` instance. The path passed to `PGlite` determines where the database is stored.

```ts
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '@brainstrike/db';

const db = new PGlite('my.db'); // ':memory:' for ephemeral or 'idb://db' for IndexedDB
await migrate(db);
```

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
