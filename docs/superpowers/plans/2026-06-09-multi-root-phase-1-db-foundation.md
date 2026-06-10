# Multi-Root Phase 1: DB Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `roots` table and a `root_id` foreign key on `file_records`, backfilled from the existing `source_root_path` strings, with zero behavior change anywhere in the app.

**Architecture:** Migration 038 creates `roots` (uuidv7 text PK, `kind`/`status` discriminants), adds nullable `file_records.root_id` with `ON DELETE CASCADE`, backfills one `kind: 'legacy'` root per distinct `source_root_path`, and adds a per-root unique cache-identity index. The migration is registered in BOTH runners (numbered `MigrationRunner` used by tests, and the drizzle `customMigrations` ledger used by the real app — registering in only one means tests pass but users never get the change). The drizzle TS schema gains matching descriptive definitions. Nothing reads or writes `root_id` yet — that's Phase 2+.

**Tech Stack:** PGlite 0.5.x (PG 18.3, `uuidv7()` built in), TypeScript strict, Vitest, dual migration runners in `@brainstrike/db`.

**Context for the engineer:**
- This repo's production migration path is `packages/db/src/drizzle/migrate.ts` (`customMigrations` ledger); tests use the numbered runner in `packages/db/src/migrations/index.ts`. Schema changes go in BOTH. Use `ALTER TABLE IF EXISTS` / `CREATE TABLE IF NOT EXISTS` — the two paths can create different table sets.
- Do NOT run `pnpm db:generate` (the drizzle schema has drifted from the manifest by design).
- `packages/db/scripts/test-lanes.mjs` (PR lanes) and `packages/db/scripts/coverage-lanes.mjs` (nightly coverage lanes) are SEPARATE registries and each errors on an unassigned `__tests__` file. test-lanes auto-matches our test via the `/^migration-/` regex; coverage-lanes needs an explicit filename entry.
- `--> statement-breakpoint` lines inside migration SQL are required by the drizzle path's statement splitter; they're SQL comments (`--` prefix) so the numbered runner ignores them.
- `file_records.embedding_set_id` is a plain text column (no FK to `embedding_sets`), so test fixtures may use arbitrary set ids without seeding `embedding_sets`.
- House rule: after changes, build + lint + type check + unit tests must all pass together. `@brainstrike/db` tests can be flaky under turbo concurrency — run them package-local.

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the working branch**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike
git checkout main && git pull && git checkout -b feat/multi-root-1-db-foundation
```

---

### Task 1: Failing migration test

**Files:**
- Test: `packages/db/__tests__/migration-038-roots-table.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/db/__tests__/migration-038-roots-table.test.ts` with exactly:

```typescript
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface RootRow {
  display_name: string;
  id: string;
  kind: string;
  path: string | null;
  status: string;
}

interface FileRecordRootRow {
  id: string;
  root_id: string | null;
  source_root_path: string | null;
}

interface CountRow {
  count: number | string;
}

describe('migration 038: roots table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-roots-table');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 38));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration038() {
    const migration = migrations.find((candidate) => candidate.version === 38);
    if (!migration) {
      throw new Error('Migration 038 is missing');
    }
    return migration;
  }

  // Migration 001 creates created_at/updated_at as TEXT NOT NULL with no
  // DEFAULT on the numbered-runner path, so seeds must supply them.
  async function seedFileRecord(
    id: string,
    path: string,
    sourceRootPath: string | null,
    embeddingSetId: string | null
  ): Promise<void> {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, source_root_path, embedding_set_id, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $6)`,
      [
        id,
        path.split('/').pop() ?? path,
        path,
        sourceRootPath,
        embeddingSetId,
        '2026-06-09T00:00:00.000Z',
      ]
    );
  }

  it(
    'creates one legacy root per distinct source_root_path and backfills root_id',
    { timeout: 60_000 },
    async () => {
      await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');
      await seedFileRecord('f2', 'src/index.ts', '/Users/alice/personal-docs', 'set-a');
      await seedFileRecord('f3', 'notes.md', '/Users/alice/work-docs', 'set-a');
      await seedFileRecord('f4', 'orphan.md', null, null);
      await seedFileRecord('f5', 'rootfile.md', '/', 'set-a');

      await runner.runMigration(getMigration038());

      const roots = await db.query<RootRow>(
        'SELECT id, kind, display_name, path, status FROM roots ORDER BY path'
      );
      expect(
        roots.rows.map((row) => ({
          display_name: row.display_name,
          kind: row.kind,
          path: row.path,
          status: row.status,
        }))
      ).toEqual([
        {
          display_name: '/',
          kind: 'legacy',
          path: '/',
          status: 'live',
        },
        {
          display_name: 'personal-docs',
          kind: 'legacy',
          path: '/Users/alice/personal-docs',
          status: 'live',
        },
        {
          display_name: 'work-docs',
          kind: 'legacy',
          path: '/Users/alice/work-docs',
          status: 'live',
        },
      ]);

      const workRoot = roots.rows.find((row) => row.display_name === 'work-docs');
      const personalRoot = roots.rows.find((row) => row.display_name === 'personal-docs');
      const records = await db.query<FileRecordRootRow>(
        'SELECT id, root_id, source_root_path FROM file_records ORDER BY id'
      );
      const byId = new Map(records.rows.map((row) => [row.id, row]));
      expect(byId.get('f1')?.root_id).toBe(workRoot?.id);
      expect(byId.get('f2')?.root_id).toBe(personalRoot?.id);
      expect(byId.get('f3')?.root_id).toBe(workRoot?.id);
      expect(byId.get('f4')?.root_id).toBeNull();
      const slashRoot = roots.rows.find((row) => row.path === '/');
      expect(byId.get('f5')?.root_id).toBe(slashRoot?.id);
    }
  );

  it(
    'enforces per-root cache identity and cascades file deletion on root removal',
    { timeout: 60_000 },
    async () => {
      await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');
      await seedFileRecord('f2', 'src/index.ts', '/Users/alice/personal-docs', 'set-a');

      await runner.runMigration(getMigration038());

      // Same (embedding_set_id, path) from two different roots coexists.
      const distinctRoots = await db.query<CountRow>(
        `SELECT COUNT(DISTINCT root_id)::int AS count FROM file_records WHERE path = 'src/index.ts'`
      );
      expect(Number(distinctRoots.rows[0]?.count ?? 0)).toBe(2);

      // Duplicate (embedding_set_id, root_id, path) is rejected.
      const workRootId = (
        await db.query<{ root_id: string }>(
          `SELECT root_id FROM file_records WHERE id = 'f1'`
        )
      ).rows[0]?.root_id;
      expect(workRootId).toBeTruthy();
      // created_at/updated_at supplied: NOT NULL fires before unique
      // constraints, which would mask the duplicate-key assertion.
      await expect(
        db.query(
          `INSERT INTO file_records (id, name, path, size, source_root_path, embedding_set_id, root_id, created_at, updated_at)
           VALUES ('f-dup', 'index.ts', 'src/index.ts', 0, '/Users/alice/work-docs', 'set-a', $1, '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z')`,
          [workRootId]
        )
      ).rejects.toThrow(/duplicate key/);

      // Deleting a root cascades to its file records and nobody else's.
      await db.query('DELETE FROM roots WHERE id = $1', [workRootId]);
      const remaining = await db.query<FileRecordRootRow>(
        'SELECT id, root_id, source_root_path FROM file_records ORDER BY id'
      );
      expect(remaining.rows.map((row) => row.id)).toEqual(['f2']);
    }
  );

  it('rollback removes roots artifacts and preserves file records', { timeout: 60_000 }, async () => {
    await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');

    const migration = getMigration038();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const rootsTable = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = 'roots'`
    );
    expect(Number(rootsTable.rows[0]?.count ?? -1)).toBe(0);

    const rootIdColumn = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
       WHERE table_name = 'file_records' AND column_name = 'root_id'`
    );
    expect(Number(rootIdColumn.rows[0]?.count ?? -1)).toBe(0);

    const records = await db.query<FileRecordRootRow>(
      'SELECT id, source_root_path FROM file_records ORDER BY id'
    );
    expect(records.rows).toEqual([
      { id: 'f1', source_root_path: '/Users/alice/work-docs' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm vitest run __tests__/migration-038-roots-table.test.ts
```

Expected: FAIL — all three tests throw `Migration 038 is missing` (the `getMigration038` guard). If they fail for any other reason (e.g., import errors), fix that before proceeding.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/db/__tests__/migration-038-roots-table.test.ts
git commit -m "test: add failing migration test for roots table (multi-root phase 1)"
```

---

### Task 2: Migration 038 implementation + numbered-runner registration

**Files:**
- Create: `packages/db/src/migrations/038-roots-table.ts`
- Modify: `packages/db/src/migrations/index.ts` (import at the end of the import block; append to the `migrations` array)

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/038-roots-table.ts` with exactly:

```typescript
import type { Migration } from './migration-runner';

/**
 * Multi-root phase 1 (inert): first-class roots table + file_records.root_id.
 *
 * Backfills one root per distinct source_root_path as kind 'legacy' — the
 * platform adapter reconciles legacy roots into 'path' (desktop) or 'fsa'
 * (web) on first restore in phase 2; SQL cannot know the platform.
 *
 * display_name strips everything up to the last '/' or '\\'; web legacy
 * values are bare folder names (no separator) and pass through unchanged.
 * Degenerate roots ('/' or 'C:\') would strip to '' — NULLIF/COALESCE
 * falls back to the full path so display_name is never empty.
 *
 * The 029 index (embedding_set_id, source_root_path, path) stays in place
 * until writes populate root_id (phase 3); both identities are enforced
 * during the transition.
 */
export const migration038RootsTable: Migration = {
  version: 38,
  name: 'roots_table',
  up: `
    CREATE TABLE IF NOT EXISTS roots (
      id TEXT PRIMARY KEY DEFAULT (uuidv7()::text),
      kind TEXT NOT NULL CHECK (kind IN ('path', 'fsa', 'snapshot', 'legacy')),
      display_name TEXT NOT NULL,
      path TEXT,
      status TEXT NOT NULL DEFAULT 'live'
        CHECK (status IN ('live', 'needs-regrant', 'disconnected', 'snapshot-stale')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ
    );
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_roots_path
      ON roots(path)
      WHERE path IS NOT NULL;
    --> statement-breakpoint

    -- cascade intentional: root removal is a full workspace wipe
    ALTER TABLE IF EXISTS file_records
      ADD COLUMN IF NOT EXISTS root_id TEXT REFERENCES roots(id) ON DELETE CASCADE;
    --> statement-breakpoint

    INSERT INTO roots (kind, display_name, path)
    SELECT
      'legacy',
      COALESCE(
        NULLIF(regexp_replace(s.source_root_path, '^.*[/\\\\]', ''), ''),
        s.source_root_path
      ),
      s.source_root_path
    FROM (
      SELECT DISTINCT source_root_path
      FROM file_records
      WHERE source_root_path IS NOT NULL
    ) AS s
    ON CONFLICT (path) WHERE path IS NOT NULL DO NOTHING;
    --> statement-breakpoint

    UPDATE file_records
    SET root_id = roots.id
    FROM roots
    WHERE file_records.source_root_path IS NOT NULL
      AND roots.path = file_records.source_root_path
      AND file_records.root_id IS NULL;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_file_records_root_id
      ON file_records(root_id);
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_root_identity
      ON file_records(embedding_set_id, root_id, path)
      WHERE embedding_set_id IS NOT NULL
        AND root_id IS NOT NULL;
  `,
  down: `
    DROP INDEX IF EXISTS idx_file_records_root_identity;
    DROP INDEX IF EXISTS idx_file_records_root_id;

    ALTER TABLE IF EXISTS file_records
      DROP COLUMN IF EXISTS root_id;

    DROP TABLE IF EXISTS roots;
  `,
};
```

Note on escaping: in the TS template literal, `'^.*[/\\\\]'` becomes the SQL string `'^.*[/\\]'`, which is the regex character class matching `/` or `\` (standard_conforming_strings is on, so SQL does not interpret backslashes; the regex engine sees `[/\]` semantics via the doubled backslash).

- [ ] **Step 2: Register in the numbered runner**

In `packages/db/src/migrations/index.ts`, add after the `migration037FileRecordMtimeMs` import (line 38):

```typescript
import { migration038RootsTable } from './038-roots-table.js';
```

and append to the `migrations` array after `migration037FileRecordMtimeMs,`:

```typescript
  migration038RootsTable,
```

- [ ] **Step 3: Run the migration test — all three should pass**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm vitest run __tests__/migration-038-roots-table.test.ts
```

Expected: PASS (3 tests). If the backfill assertions fail on `display_name`, check the regexp escaping note in Step 1 before changing anything else.

- [ ] **Step 4: Run the full schema-migration lane (other migration tests assert global invariants and may enumerate migrations)**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm run test:db:schema-migration
```

Expected: PASS. If `migration-runner.test.ts`, `migration-integration.test.ts`, or `db-migration-authority.test.ts` fail with an expectation about the migration count/list, update that test's expected list to include version 38 / `roots_table` — read the failing assertion and mirror the existing pattern for 037.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/038-roots-table.ts packages/db/src/migrations/index.ts
git commit -m "feat(db): add roots table migration with legacy backfill (multi-root phase 1)"
```

---

### Task 3: Drizzle ledger registration (the production path)

**Files:**
- Modify: `packages/db/src/drizzle/migrate.ts` (import block at top; `customMigrations` array, currently ending at line 158 with `custom-037-file-record-mtime-ms`)

- [ ] **Step 1: Register the custom migration**

In `packages/db/src/drizzle/migrate.ts`, add `migration038RootsTable` to the existing import from the numbered migrations (match how `migration037FileRecordMtimeMs` is imported at the top of the file), then append inside the `customMigrations` array after the `custom-037-file-record-mtime-ms` entry:

```typescript
  customMigration('custom-038-roots-table', migration038RootsTable),
```

The ledger is append-only by design — never reorder or rewrite existing entries.

- [ ] **Step 2: Run the drizzle-path and authority-guard tests**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm vitest run __tests__/drizzle-migrate.test.ts __tests__/migration-authority-guard.test.ts __tests__/db-migration-authority.test.ts
```

Expected: PASS. If a guard test asserts the expected custom-migration hash list, add `'custom-038-roots-table'` following the existing pattern for `'custom-037-file-record-mtime-ms'`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/migrate.ts
git commit -m "feat(db): register roots table migration in drizzle ledger"
```

(Include any guard-test fixture updates from Step 2 in this commit.)

---

### Task 4: Drizzle TS schema definitions

**Files:**
- Modify: `packages/db/src/schema/index.ts` (add `roots` table immediately before the `FILE RECORDS TABLE` banner at line 119; add `rootId` column + index to `fileRecords` at lines 123–152)

- [ ] **Step 1: Add the roots table definition**

Insert immediately before the `// FILE RECORDS TABLE` banner comment (line 119):

```typescript
// ============================================================================
// ROOTS TABLE
// ============================================================================

export const roots = pgTable('roots', {
  id: text('id')
    .primaryKey()
    .default(sql`(uuidv7()::text)`),
  kind: text('kind').$type<'path' | 'fsa' | 'snapshot' | 'legacy'>().notNull(),
  displayName: text('display_name').notNull(),
  path: text('path'),
  status: text('status')
    .$type<'live' | 'needs-regrant' | 'disconnected' | 'snapshot-stale'>()
    .default('live')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
});
```

`sql`, `text`, `timestamp`, and `pgTable` are already imported in this file (verify the import list at the top and add any that are missing to the existing import statement — `timestamp` is used by `collectionIndexingStats` at line 268, `sql` by `textTimestampNow` at line 117).

- [ ] **Step 2: Add rootId to fileRecords**

In the `fileRecords` table (line 123), add after the `sourceRootPath` column (line 129):

```typescript
    rootId: text('root_id').references(() => roots.id, { onDelete: 'cascade' }),
```

and add to the index array (after line 150):

```typescript
    index('idx_file_records_root_id').on(table.rootId),
```

(The existing schema models the 029 unique index as a plain descriptive index only; follow that precedent — do not introduce `uniqueIndex` here.)

Also add to the `TYPE EXPORTS` block at the bottom of the file (house convention — every table exports its inferred pair):

```typescript
export type Root = typeof roots.$inferSelect;
export type NewRoot = typeof roots.$inferInsert;
```

- [ ] **Step 3: Build and type-check the package**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike
pnpm --filter @brainstrike/db build
```

Expected: clean tsc build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/index.ts
git commit -m "feat(db): add roots drizzle schema and fileRecords.rootId"
```

---

### Task 5: Lane registry — coverage lanes (the #1101 trap)

**Files:**
- Modify: `packages/db/scripts/coverage-lanes.mjs` (the `migrations` lane array, lines 48–66)

- [ ] **Step 1: Register the test file in the coverage lanes**

In `packages/db/scripts/coverage-lanes.mjs`, add to the `migrations` array, alphabetically between `'migration-authority-guard.test.ts'` and `'migration-integration.test.ts'`:

```javascript
    'migration-038-roots-table.test.ts',
```

(test-lanes.mjs needs no change — its `/^migration-/` regex in the `schema-migration` lane already claims the file.)

- [ ] **Step 2: Verify BOTH lane registries**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm run test:db:check-lanes
pnpm run test:coverage:db:check-lanes
```

Expected: both exit 0 with no unassigned-file errors.

- [ ] **Step 3: Commit**

```bash
git add packages/db/scripts/coverage-lanes.mjs
git commit -m "chore(db): register roots migration test in coverage lanes"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Format/lint pass**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike
pnpm dlx ultracite fix
git diff --stat
```

Expected: no diff, or only formatting churn in files this plan touched. If ultracite reformatted plan files, amend them into the relevant commits or add a `style:` commit.

- [ ] **Step 2: Full db package test suite (package-local — db tests are flaky under turbo concurrency)**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike/packages/db
pnpm test
```

Expected: all lanes PASS. Re-run a failed lane in isolation once before treating it as a real failure.

- [ ] **Step 3: Monorepo static gates**

```bash
cd /Users/seandearnaley/Documents/GitHub/brainstrike
pnpm turbo run build --filter=@brainstrike/db...
pnpm dlx ultracite check
```

Expected: build of db and all dependents clean; ultracite check clean.

- [ ] **Step 4: Final commit (if any stragglers) and summary**

```bash
git status
git log --oneline main..HEAD
```

Expected log (roughly):
```
chore(db): register roots migration test in coverage lanes
feat(db): add roots drizzle schema and fileRecords.rootId
feat(db): register roots table migration in drizzle ledger
feat(db): add roots table migration with legacy backfill (multi-root phase 1)
test: add failing migration test for roots table (multi-root phase 1)
```

Do not push or open a PR without explicit confirmation.

---

## Out of scope for this plan (later phases — see roadmap)

- Reading/writing `root_id` from any repository, pipeline, or UI code.
- Reconciling `kind: 'legacy'` roots to `path`/`fsa` (Phase 2, adapter layer).
- Dropping the 029 `idx_file_records_cache_identity` index or `source_root_path` column (only after Phase 3 makes writes root-aware).
- `NOT NULL` on `root_id` (only after all writers populate it).
- Factory-reset changes (the roots table lives in the existing DB, which factory reset already purges wholesale; per-root reset arrives with the UI).
