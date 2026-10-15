// @vitest-environment node
/**
 * BST-1794 end-to-end proof.
 *
 * Every other model-registry-store test (model-registry-store.test.ts) drives
 * `initializeProviderModelDefaults` against a MOCKED `db.query` — useful for
 * fast unit coverage of call shape and branching, but it cannot prove the
 * per-row `untouched = !is_enabled && updated_at === created_at` predicate
 * against the actual schema, actual column types, or the actual numbered +
 * drizzle migrations that ship the seven previously-unreachable catalog
 * models (packages/db/src/migrations/{104,116,122,123,124}-*.ts).
 *
 * This file exercises the REAL store action against a REAL PGlite database,
 * built with the same production entry points the app itself uses:
 *   - `createEnginePglite` (packages/db/src/pglite-factory.ts) for the full
 *     engine-extension set (docs/agents/database.md § "Remaining PGlite
 *     consumers" — every construction site loads pg_textsearch/pg_trgm/vector).
 *   - `migrate` (packages/db/src/migrations/bootstrap.ts), the production
 *     drizzle migration bootstrap — the exact path a greenfield app database
 *     runs, not a hand-rolled subset of migrations.
 * The store action itself is untouched: the real Zustand store, the real
 * `useModelRegistryStore.getState().initializeProviderModelDefaults`, driven
 * exactly as `packages/app-shell/src/hooks/use-provider-model-defaults.ts`
 * drives it in production, including the real
 * `getProviderModelDefaultPolicy` policy table from `@brainstrike/assistant-
 * contract` (no hand-typed policy objects that could silently drift from
 * what the app actually ships).
 *
 * `packages/app-state` had no prior `*.integration.test.*` files, so this
 * addition also wires the package into the repo's cache-soundness partition
 * (turbo.jsonc's uncached `test:integration` task; guarded by
 * scripts/__tests__/integration-suffix-partition.test.mjs): see the sibling
 * `vitest.integration.config.mts` and the `test` / `test:integration` split
 * in `package.json`.
 */
import { getProviderModelDefaultPolicy } from '@brainstrike/assistant-contract';
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../stores/model-registry-store';

// `@electric-sql/pglite` is not a direct dependency of this package (only
// @brainstrike/db owns it); derive the instance type from the production
// factory instead of adding a new dependency just for a test-file type.
type EnginePglite = Awaited<ReturnType<typeof createEnginePglite>>;

interface ModelRow {
  readonly created_at: Date;
  readonly id: string;
  readonly is_enabled: boolean;
  readonly provider_id: string;
  readonly updated_at: Date;
}

/**
 * The seven catalog models BST-1794 fixed: shipped `is_enabled = false` by
 * their migration, and permanently unreachable under the old provider-wide
 * predicate. Migration that added each, per the task brief: gpt-6-astra (123),
 * claude-opus-5 (116), claude-fable-5-1 (122), gemini-3.8-flash/3.6-flash/
 * 3.5-flash-lite (124), gemini-3.7-flash (104, predates 124 but was equally
 * dark under the old predicate).
 */
const DARK_MODEL_IDS = [
  'gpt-6-astra',
  'claude-opus-5',
  'claude-fable-5-1',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
] as const;

const EMBEDDING_MODEL_IDS = ['text-embedding-3-small', 'text-embedding-3-large'] as const;

async function queryModels(db: EnginePglite, ids: readonly string[]): Promise<ModelRow[]> {
  const result = await db.query<ModelRow>(
    `SELECT id, provider_id, is_enabled, created_at, updated_at
     FROM models WHERE id = ANY($1) ORDER BY id`,
    [ids]
  );
  return result.rows;
}

describe('initializeProviderModelDefaults against a real PGlite database (BST-1794)', () => {
  let db: EnginePglite;

  beforeEach(async () => {
    db = await createEnginePglite();
    await migrate(db);
    __resetModelRegistryStoreForTests();
  });

  afterEach(async () => {
    await db.close();
  });

  it('1. ships all seven previously-dark models disabled and untouched', async () => {
    const rows = await queryModels(db, DARK_MODEL_IDS);
    expect(rows).toHaveLength(DARK_MODEL_IDS.length);

    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const id of DARK_MODEL_IDS) {
      const row = rowsById.get(id);
      expect(row, `expected migrations to have seeded ${id}`).toBeDefined();
      expect(row?.is_enabled).toBe(false);
      expect(row?.updated_at.getTime()).toBe(row?.created_at.getTime());
    }
  });

  it('2. flips every one of the seven dark models to enabled under the real availability policy', async () => {
    for (const providerId of ['anthropic', 'openai', 'google'] as const) {
      const policy = getProviderModelDefaultPolicy(providerId);
      expect(policy).toEqual({ kind: 'all' });
      if (!policy) {
        throw new Error(`expected a policy for ${providerId}`);
      }
      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(db as unknown as DbHandle, providerId, policy);
      expect(result).toBe('initialized');
    }

    const rows = await queryModels(db, DARK_MODEL_IDS);
    expect(rows).toHaveLength(DARK_MODEL_IDS.length);
    for (const row of rows) {
      expect(row.is_enabled, `expected ${row.id} to be enabled`).toBe(true);
    }
  });

  it("3. preserves a user's explicit disable choice across the availability policy", async () => {
    // Pick a row the real catalog ships enabled, rather than hard-coding an
    // id that a future catalog migration could rename or remove.
    const shipsEnabled = (
      await db.query<{ id: string }>(
        `SELECT id FROM models
         WHERE provider_id = 'openai' AND capabilities->>'type' = 'llm' AND is_enabled = true
         ORDER BY id LIMIT 1`
      )
    ).rows[0];
    expect(shipsEnabled, 'expected at least one openai LLM row to ship enabled').toBeDefined();
    const userChoiceId = shipsEnabled?.id as string;

    // Simulate the user turning it off: is_enabled=false with an updated_at
    // that now diverges from created_at, exactly what a real toggle does.
    await db.query('UPDATE models SET is_enabled = false, updated_at = NOW() WHERE id = $1', [
      userChoiceId,
    ]);
    const [beforeRow] = await queryModels(db, [userChoiceId]);
    if (!beforeRow) {
      throw new Error(`expected ${userChoiceId} to exist after the simulated toggle`);
    }
    expect(beforeRow.is_enabled).toBe(false);
    expect(beforeRow.updated_at.getTime()).not.toBe(beforeRow.created_at.getTime());

    const policy = getProviderModelDefaultPolicy('openai');
    if (!policy) {
      throw new Error('expected a policy for openai');
    }
    await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'openai', policy);

    const [afterRow] = await queryModels(db, [userChoiceId]);
    if (!afterRow) {
      throw new Error(
        `expected ${userChoiceId} to still exist after initializeProviderModelDefaults`
      );
    }
    expect(afterRow.is_enabled).toBe(false);
    expect(afterRow.updated_at.getTime()).toBe(beforeRow.updated_at.getTime());
  });

  it('4. leaves embedding rows untouched by the all policy', async () => {
    const before = await queryModels(db, EMBEDDING_MODEL_IDS);
    expect(before).toHaveLength(EMBEDDING_MODEL_IDS.length);

    const policy = getProviderModelDefaultPolicy('openai');
    if (!policy) {
      throw new Error('expected a policy for openai');
    }
    await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'openai', policy);

    const after = await queryModels(db, EMBEDDING_MODEL_IDS);
    expect(after).toEqual(before);
  });

  it('5. is idempotent: a second run is preserved and rewrites nothing', async () => {
    const policy = getProviderModelDefaultPolicy('google');
    if (!policy) {
      throw new Error('expected a policy for google');
    }

    const first = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'google', policy);
    expect(first).toBe('initialized');

    const afterFirstRun = (
      await db.query<ModelRow>(
        `SELECT id, provider_id, is_enabled, created_at, updated_at
         FROM models WHERE provider_id = 'google' ORDER BY id`
      )
    ).rows;
    expect(afterFirstRun.length).toBeGreaterThan(0);

    const second = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'google', policy);
    expect(second).toBe('preserved');

    const afterSecondRun = (
      await db.query<ModelRow>(
        `SELECT id, provider_id, is_enabled, created_at, updated_at
         FROM models WHERE provider_id = 'google' ORDER BY id`
      )
    ).rows;

    // Deep equality (vitest compares Date fields by value), so this proves no
    // row's updated_at moved between the two runs, not just that the ids match.
    expect(afterSecondRun).toEqual(afterFirstRun);
  });

  it('6. runs the unchanged seed path: enables the recommended openrouter set, then preserves on replay', async () => {
    const policy = getProviderModelDefaultPolicy('openrouter');
    expect(policy?.kind).toBe('seed');
    if (policy?.kind !== 'seed') {
      throw new Error('expected a seed policy for openrouter');
    }
    expect(policy.modelIds.length).toBeGreaterThan(0);

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'openrouter', policy);
    expect(result).toBe('initialized');

    const recommended = await queryModels(db, policy.modelIds);
    expect(recommended).toHaveLength(policy.modelIds.length);
    for (const row of recommended) {
      expect(row.is_enabled, `expected recommended row ${row.id} to be enabled`).toBe(true);
    }

    // Toggle one recommended row off (a user choice on top of the seeded
    // set) and confirm the provider-wide gate still preserves on replay.
    const [toggledId] = policy.modelIds;
    await db.query('UPDATE models SET is_enabled = false, updated_at = NOW() WHERE id = $1', [
      toggledId,
    ]);

    const replay = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(db as unknown as DbHandle, 'openrouter', policy);
    expect(replay).toBe('preserved');
  });
});
