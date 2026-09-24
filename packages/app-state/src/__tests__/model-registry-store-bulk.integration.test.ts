// @vitest-environment node
/**
 * BST-1805: `setModelsEnabled` against a REAL PGlite database built with the
 * production entry points (`createEnginePglite` + `migrate`), proving the one
 * atomic statement — `id = ANY($2)` plus the count guard — on the real schema.
 * The mocked suite (model-registry-store-bulk.test.ts) cannot prove the SQL.
 */
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';

type EnginePglite = Awaited<ReturnType<typeof createEnginePglite>>;

interface ModelRow {
  readonly id: string;
  readonly is_enabled: boolean;
  readonly name: string;
  readonly provider_id: string;
  readonly sort_order: number;
  readonly touched: boolean;
}

// Both ship `is_enabled = false` and untouched (pinned by the BST-1794
// integration suite, model-registry-store.integration.test.ts).
const TARGET_IDS = ['claude-opus-5', 'gpt-6-astra'] as const;

async function readRows(db: EnginePglite, ids: readonly string[]): Promise<ModelRow[]> {
  const result = await db.query<ModelRow>(
    `SELECT id, name, provider_id, sort_order, is_enabled, updated_at > created_at AS touched
     FROM models WHERE id = ANY($1) ORDER BY id`,
    [ids]
  );
  return result.rows;
}

function toStoreModel(row: ModelRow): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    id: row.id,
    isEnabled: row.is_enabled,
    name: row.name,
    parameters: null,
    providerId: row.provider_id,
    sortOrder: row.sort_order,
    tagline: null,
  };
}

describe('setModelsEnabled against a real PGlite database (BST-1805)', () => {
  let db: EnginePglite;

  beforeEach(async () => {
    db = await createEnginePglite();
    await migrate(db);
    __resetModelRegistryStoreForTests();
  });

  afterEach(async () => {
    // A failure schedules fetchRegistry; let it settle before closing the database.
    await vi.waitFor(() => {
      expect(useModelRegistryStore.getState().isLoading).toBe(false);
    });
    await db.close();
  });

  it('enables every id in one statement, marks the choice, and returns the prior states', async () => {
    const before = await readRows(db, TARGET_IDS);
    expect(before.map((row) => row.is_enabled)).toEqual([false, false]);
    useModelRegistryStore.setState({ models: before.map(toStoreModel) });

    const previous = await useModelRegistryStore
      .getState()
      .setModelsEnabled(db as unknown as DbHandle, TARGET_IDS, true);

    expect(Object.fromEntries(previous)).toEqual({ 'claude-opus-5': false, 'gpt-6-astra': false });
    for (const row of await readRows(db, TARGET_IDS)) {
      expect(row.is_enabled, row.id).toBe(true);
      expect(row.touched, row.id).toBe(true);
    }
  });

  it('writes NOTHING when one id is missing from the database, and restores the store', async () => {
    const [opus] = await readRows(db, ['claude-opus-5']);
    if (!opus) {
      throw new Error('expected migrations to seed claude-opus-5');
    }
    useModelRegistryStore.setState({
      models: [toStoreModel(opus), { ...toStoreModel(opus), id: 'not-in-the-database' }],
    });

    await expect(
      useModelRegistryStore
        .getState()
        .setModelsEnabled(db as unknown as DbHandle, ['claude-opus-5', 'not-in-the-database'], true)
    ).rejects.toThrow('nothing was changed');

    const [after] = await readRows(db, ['claude-opus-5']);
    expect(after?.is_enabled).toBe(false);
    expect(after?.touched).toBe(false);
    expect(
      useModelRegistryStore.getState().models.find((entry) => entry.id === 'claude-opus-5')
        ?.isEnabled
    ).toBe(false);
  });
});
