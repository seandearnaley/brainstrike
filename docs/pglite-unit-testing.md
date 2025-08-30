One-pager: Fast, realistic DB testing in a Turborepo (Vitest + Playwright) with PGlite & Postgres

TL;DR
	•	Do not mock your DB client. Use PGlite for fast unit/“micro-integration” tests, and real Postgres via Testcontainers for full-fidelity integration/E2E.  ￼ ￼ ￼ ￼

⸻

What goes where
	•	Vitest (fast tier) → PGlite in-process DB. Real SQL, no Docker, great for hermetic speed. Keep suites tiny and schema-focused. Examples from the community wire Drizzle/Prisma to PGlite directly.  ￼ ￼ ￼
	•	Playwright & “heavy” integration → Testcontainers Postgres. Catches pooling, DDL, auth, extensions, and planner quirks under realistic conditions.  ￼ ￼

⸻

Turborepo wiring (structure)

/apps
  web/ … (Playwright tests live here)
  api/ … (Vitest + unit/integration)
  …
/packages
  db/         # migrations, schema, seed helpers (shared)
  test-utils/ # adapters: getDb() for PGlite | Postgres

	•	Put migrations/seeders in a shared packages/db so both tiers run the exact same files.  ￼
	•	Expose a tiny DB provider in packages/test-utils that can swap PGlite↔Postgres based on env. (See code below.)  ￼

⸻

Vitest: PGlite setup (fast tier)

Install

pnpm add -D vitest @electric-sql/pglite

packages/test-utils/src/db.ts

import { PGlite } from "@electric-sql/pglite";

export async function getPglite() {
  const db = new PGlite('memory://');  // true in-memory WASM Postgres (Node/Web)
  await db.query(/* run migrations here, e.g., squashed SQL */);
  return db;
}

apps/api/vitest.setup.ts

import { beforeAll, afterAll } from "vitest";
import { getPglite } from "@acme/test-utils/db";

export let db: any;

beforeAll(async () => {
  db = await getPglite();
  // optionally seed minimal test data
});

afterAll(async () => {
  await db.end?.(); // no-op for PGlite, safe if provided
});

apps/api/vite.config.ts

/// <reference types="vitest" />
import { defineConfig } from "vite";
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    isolate: true,            // per-file env
    pool: "threads",          // or "forks" to avoid WASM contention
    // consider "singleThread: true" for DB-heavy files
  },
});

Notes
	•	Vitest supports global setup files and per-suite isolation; keep DB-touching tests small to avoid parallel contention.  ￼ ￼
	•	Real Drizzle+PGlite example repos show the one-line swap and test wiring.  ￼ ￼
	•	PGlite is a full Postgres in WASM (tiny, fast) with extension support (e.g., pgvector); perfect for this tier.  ￼ ￼

⸻

Playwright: E2E with real Postgres (Testcontainers)

Install

pnpm add -D @playwright/test testcontainers pg

packages/test-utils/src/pg-container.ts

import { StartedTestContainer, GenericContainer } from "testcontainers";
export async function startPostgres() {
  const container = await new GenericContainer("postgres:16-alpine")
    .withEnv("POSTGRES_USER", "test")
    .withEnv("POSTGRES_PASSWORD", "test")
    .withEnv("POSTGRES_DB", "app")
    .withExposedPorts(5432)
    .start();
  const port = container.getMappedPort(5432);
  const host = container.getHost();
  const url = `postgres://test:test@${host}:${port}/app`;
  return { container, url };
}

apps/web/playwright.config.ts

import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  },
  globalSetup: require.resolve("./pw.global-setup"),
  globalTimeout: 10 * 60 * 1000,
});

apps/web/pw.global-setup.ts

import { FullConfig } from "@playwright/test";
import { startPostgres } from "@acme/test-utils/pg-container";
import { migrateAndSeed } from "@acme/db/migrate-seed";
import { spawn } from "node:child_process";

let container: any;

async function waitOn(url: string) {
  // poll a /healthz endpoint before running tests
}

export default async function (_config: FullConfig) {
  const pg = await startPostgres();
  process.env.DATABASE_URL = pg.url;   // app & tests read this

  await migrateAndSeed(pg.url);        // same migrations as Vitest tier

  // Start your API / web app pointed at the ephemeral DB:
  const api = spawn("pnpm", ["--filter", "api", "start:test"], { stdio: "inherit" });
  const web = spawn("pnpm", ["--filter", "web", "start:test"], { stdio: "inherit" });

  await waitOn(process.env.E2E_BASE_URL ?? "http://localhost:3000");
  (global as any).__E2E__ = { api, web, container: pg.container };
}

export async function teardown() {
  const g = (global as any).__E2E__;
  g?.api?.kill(); g?.web?.kill();
  await g?.container?.stop();          // disposable DB
}

	•	Why Testcontainers: real Postgres lifecycle per run; widely documented patterns for Node/Vitest/Playwright.  ￼ ￼ ￼
	•	Playwright + DB validation patterns are common; wire your app to the containerized DB and assert UI + DB state.  ￼ ￼

⸻

Migrations & seeds (shared)

Expose a single function in packages/db:

export async function migrateAndSeed(databaseUrlOrClient: string | { query: Function }) {
  // apply SQL migrations (Kysely/Drizzle/Prisma CLI or raw SQL)
  // insert minimal seed data
}

	•	Keep migration parity across PGlite (Vitest) and Postgres (E2E) to surface differences early.  ￼

⸻

CI & caching
	•	In Turborepo, define two pipelines:
	•	test:fast (Vitest + PGlite) → runs on every PR; cache by inputs (schema + test files).
	•	test:e2e (Playwright + Testcontainers) → runs on label/changed-paths/nightly; don’t over-cache as DB state is ephemeral. Community guidance favors isolated DBs per suite.  ￼ ￼

⸻

Gotchas & tips
	•	Parallelism: PGlite is single-process; keep DB-heavy unit tests in band or shard by file.  ￼
	•	Extensions: If your prod DB needs extensions, assert them in the Testcontainers tier; PGlite supports many but not all.  ￼
	•	Health checks: Gate Playwright runs on app /healthz + DB connectivity to reduce flakes. Patterns in guides show this explicitly.  ￼ ￼

⸻

Further references (skim-ready)
	•	PGlite docs/overview – embeddable Postgres in WASM w/ pgvector support.  ￼
	•	Drizzle + PGlite – official connection guide; community Vitest demo repo.  ￼ ￼
	•	Testcontainers Node – official site + repo; Postgres getting-started.  ￼ ￼
	•	Playwright + Postgres testing – end-to-end patterns.  ￼ ￼

⸻

Bottom line
	•	Vitest + PGlite for speed and realism where it matters most.
	•	Playwright + Testcontainers to catch production-class issues.
That split keeps the suite fast, deterministic, and production-faithful at scale.
