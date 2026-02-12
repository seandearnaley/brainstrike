---
title: PGlite Unit Testing
sidebar_position: 10
---

# PGlite Unit Testing Strategy

Use a two-tier database testing strategy:

- **Fast tier (Vitest):** PGlite in-process for fast, hermetic SQL tests.
- **Fidelity tier (Playwright/E2E):** ephemeral Postgres via Testcontainers.

## Why This Split Works

- PGlite gives realistic SQL behavior without Docker startup cost.
- Testcontainers catches real Postgres runtime differences (extensions, connection behavior, migration edge cases).
- Shared migrations and seed logic keep both tiers aligned.

## Recommended Workspace Shape

```text
apps/
  web/
  desktop/
packages/
  db/         # migrations + schema + seed helpers
  test-utils/ # db adapters for PGlite and Postgres container
```

## Fast Tier: Vitest + PGlite

```ts
import { PGlite } from '@electric-sql/pglite';

export const createUnitTestDb = async (): Promise<PGlite> => {
  const db = new PGlite('memory://');
  // apply migrations and minimal seed data here
  return db;
};
```

Guidelines:

- Keep tests focused and small.
- Avoid broad fixture graphs.
- Prefer deterministic seeds over random data.

## Fidelity Tier: Playwright + Testcontainers Postgres

```ts
import { GenericContainer } from 'testcontainers';

export const startPostgres = async (): Promise<{ url: string }> => {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnv('POSTGRES_USER', 'test')
    .withEnv('POSTGRES_PASSWORD', 'test')
    .withEnv('POSTGRES_DB', 'app')
    .withExposedPorts(5432)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return { url: `postgres://test:test@${host}:${port}/app` };
};
```

Guidelines:

- Run real migrations before tests start.
- Gate test execution on app and DB health checks.
- Destroy container resources in global teardown.

## Migration Parity Contract

A single shared function should apply migrations for both tiers.

```ts
export const migrateAndSeed = async (connection: string): Promise<void> => {
  // apply schema migrations
  // write minimal deterministic seed data
};
```

## CI Recommendation

- Run PGlite tests on every PR.
- Run Postgres container E2E on merge gates, changed-path rules, or scheduled builds.
- Keep performance-sensitive E2E suites isolated from fast feedback checks.
