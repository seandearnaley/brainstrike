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

Create a context so other components can access the `FileRecordRepository`:

```tsx
import { PGlite } from '@electric-sql/pglite';
import { FileRecordRepository, migrate } from '@brainstrike/db';
import React, { createContext, useContext, useMemo } from 'react';

const db = new PGlite('app.db');
await migrate(db);
const repo = new FileRecordRepository(db);

const DbContext = createContext<{ fileRecordRepository: FileRecordRepository } | null>(null);

export const DbProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMemo(() => ({ fileRecordRepository: repo }), []);
  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
};

export const useFileRecordRepository = () => {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useFileRecordRepository must be used within a DbProvider');
  return ctx.fileRecordRepository;
};
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
