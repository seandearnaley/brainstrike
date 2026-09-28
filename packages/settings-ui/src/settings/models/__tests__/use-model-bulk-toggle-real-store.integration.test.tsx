/**
 * BST-1805 final review: bulk change + Undo against the REAL model-registry
 * store and a REAL PGlite database (production `createEnginePglite` +
 * `migrate`), so Undo is proven against what the store and SQL actually do —
 * including a single-row toggle made after the bulk change, which Undo must
 * leave alone.
 */
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { act, renderHook } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EnginePglite = Awaited<ReturnType<typeof createEnginePglite>>;

const toast = vi.fn();
const database = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => database.current }));

import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { useModelBulkToggle } from '../use-model-bulk-toggle';
import { useModelToggle } from '../use-model-toggle';

// Both ship `is_enabled = false` (pinned by app-state's BST-1794 integration suite).
const IDS = ['claude-opus-5', 'gpt-6-astra'] as const;

interface ModelRow {
  readonly id: string;
  readonly is_enabled: boolean;
  readonly name: string;
  readonly provider_id: string;
  readonly sort_order: number;
}

async function readRows(db: EnginePglite): Promise<ModelRow[]> {
  const result = await db.query<ModelRow>(
    'SELECT id, name, provider_id, sort_order, is_enabled FROM models WHERE id = ANY($1) ORDER BY id',
    [IDS]
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

async function enabledById(db: EnginePglite): Promise<Record<string, boolean>> {
  return Object.fromEntries((await readRows(db)).map((row) => [row.id, row.is_enabled]));
}

async function updatedAt(db: EnginePglite, id: string): Promise<string> {
  const result = await db.query<{ readonly stamp: string }>(
    'SELECT updated_at::text AS stamp FROM models WHERE id = $1',
    [id]
  );
  const stamp = result.rows[0]?.stamp;
  if (stamp === undefined) {
    throw new Error(`expected migrations to seed ${id}`);
  }
  return stamp;
}

/** Clicks the bulk toast's Undo and waits, inside act, for the result toast. */
async function clickUndo(): Promise<void> {
  const options = toast.mock.calls[0]?.[0] as
    | { action?: ReactElement<{ onClick?: () => void }> }
    | undefined;
  const onClick = options?.action?.props.onClick;
  if (!onClick) {
    throw new Error('the bulk toast carries no Undo action');
  }
  await act(async () => {
    onClick();
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledTimes(2);
    });
  });
}

describe('bulk change + Undo against the real store and PGlite (BST-1805)', () => {
  let db: EnginePglite;

  beforeEach(
    async () => {
      toast.mockReset();
      db = await createEnginePglite();
      await migrate(db);
      database.current = db;
      __resetModelRegistryStoreForTests();
      useModelRegistryStore.setState({ models: (await readRows(db)).map(toStoreModel) });
    },
    // Cold WASM initialization and the real migration chain need a bounded
    // setup budget; this does not change either test's assertion timeout.
    30_000
  );

  afterEach(async () => {
    await db.close();
    database.current = null;
  });

  function renderBulk() {
    return renderHook(() => {
      const controller = useModelToggle();
      return { bulk: useModelBulkToggle(controller), toggle: controller.toggle };
    });
  }

  it('Undo restores every row the bulk change wrote', async () => {
    const { result } = renderBulk();
    await act(async () => {
      await result.current.bulk({ enabled: true, modelIds: IDS, scopeLabel: 'Mixed' });
    });
    expect(await enabledById(db)).toEqual({ 'claude-opus-5': true, 'gpt-6-astra': true });

    await clickUndo();

    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Restored 2 models' }));
    expect(await enabledById(db)).toEqual({ 'claude-opus-5': false, 'gpt-6-astra': false });
  });

  it('Undo does not write a row toggled after the bulk change, and reports the partial restore', async () => {
    const { result } = renderBulk();
    await act(async () => {
      await result.current.bulk({ enabled: true, modelIds: IDS, scopeLabel: 'Mixed' });
    });
    // The user's newer choice: disable one row by hand after the bulk enable.
    await act(async () => {
      await result.current.toggle('gpt-6-astra', false);
    });
    const handToggledAt = await updatedAt(db, 'gpt-6-astra');

    await clickUndo();

    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Restored 1 of 2 models' })
    );
    expect(await enabledById(db)).toEqual({ 'claude-opus-5': false, 'gpt-6-astra': false });
    // Undo never wrote the hand-toggled row (a write would bump updated_at).
    expect(await updatedAt(db, 'gpt-6-astra')).toBe(handToggledAt);
  });
});
