import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import { __resetSettingsTestOverridesForTests } from '../testing/e2e-settings-test-overrides';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

function model(id: string, isEnabled: boolean): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    id,
    isEnabled,
    name: id,
    parameters: null,
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
  };
}

function enabledStates(): Record<string, boolean> {
  return Object.fromEntries(
    useModelRegistryStore.getState().models.map((entry) => [entry.id, entry.isEnabled])
  );
}

// The scheduled refresh never settles, so any restore we observe is the
// store's own synchronous rollback, not the refresh.
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {
    // intentionally pending
  });
}

describe('model-registry-store setModelsEnabled (BST-1805)', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
    useModelRegistryStore.setState({
      models: [model('a', false), model('b', true), model('c', false)],
    });
  });

  it('writes every id in ONE atomic statement and resolves with the prior states', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
    const previous = await useModelRegistryStore
      .getState()
      .setModelsEnabled({ query } as never, ['a', 'b'], true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('WHERE id = ANY($2)');
    expect(sql).toContain('(SELECT count(*) FROM models WHERE id = ANY($2)) = $3');
    expect(params).toEqual([true, ['a', 'b'], 2]);
    expect([...previous]).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(enabledStates()).toEqual({ a: true, b: true, c: false });
  });

  it('re-applies the committed states when a stale refresh lands mid-write (toggleModel parity)', async () => {
    const query = vi.fn(() => {
      // A registry refresh that read the table BEFORE this write commits.
      useModelRegistryStore.setState({
        models: [model('a', false), model('b', true), model('c', false)],
      });
      return Promise.resolve({ rows: [{ id: 'a' }, { id: 'c' }] });
    });
    await useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'c'], true);
    expect(enabledStates()).toEqual({ a: true, b: true, c: true });
  });

  it('restores the exact prior per-id states synchronously when the write rejects', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockReturnValueOnce(neverSettles());
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'b', 'c'], true)
    ).rejects.toThrow('disk full');
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('treats a short RETURNING set as a failure and restores', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockReturnValueOnce(neverSettles());
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'c'], true)
    ).rejects.toThrow('nothing was changed');
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('refuses ids the loaded registry does not hold, without writing', async () => {
    const query = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'zzz'], true)
    ).rejects.toThrow('zzz');
    expect(query).not.toHaveBeenCalled();
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('refuses an empty id list without writing', async () => {
    const query = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, [], true)
    ).rejects.toThrow('at least one model');
    expect(query).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'a' }] });
    await useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a', 'a'], true);
    expect(query.mock.calls[0]?.[1]).toEqual([true, ['a'], 1]);
  });

  it('schedules a registry refresh after a failure', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ query } as never, ['a'], true)
    ).rejects.toThrow('disk full');
    await vi.waitFor(() => {
      expect(useModelRegistryStore.getState().hasLoaded).toBe(true);
    });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
