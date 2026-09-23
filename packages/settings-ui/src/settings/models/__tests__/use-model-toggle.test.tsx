import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
const toggleModel = vi.fn<(db: unknown, modelId: string, enabled: boolean) => Promise<void>>();
let db: unknown = { query: vi.fn() };

vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => db }));
const setModelsEnabled =
  vi.fn<
    (db: unknown, ids: readonly string[], enabled: boolean) => Promise<ReadonlyMap<string, boolean>>
  >();

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (
    selector: (state: {
      setModelsEnabled: typeof setModelsEnabled;
      toggleModel: typeof toggleModel;
    }) => unknown
  ) => selector({ setModelsEnabled, toggleModel }),
}));

import { type ModelBulkToggleOutcome, useModelToggle } from '../use-model-toggle';

describe('useModelToggle', () => {
  beforeEach(() => {
    toast.mockClear();
    toggleModel.mockReset();
    setModelsEnabled.mockReset();
    db = { query: vi.fn() };
  });

  it('resolves true once the write commits', async () => {
    toggleModel.mockResolvedValue(undefined);
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(true);
    expect(toggleModel).toHaveBeenCalledWith(db, 'claude-opus-5', true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('resolves false and toasts when the write is rejected', async () => {
    toggleModel.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'disk full', variant: 'destructive' })
    );
  });

  it('resolves false and toasts without writing when the database is not ready', async () => {
    db = null;
    const { result } = renderHook(() => useModelToggle());
    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.toggle('claude-opus-5', true);
    });
    expect(committed).toBe(false);
    expect(toggleModel).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('releases the busy flag after either outcome', async () => {
    toggleModel.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useModelToggle());
    await act(async () => {
      await result.current.toggle('m', true);
    });
    expect(result.current.busyModelIds.has('m')).toBe(false);
  });
});

describe('useModelToggle.toggleMany (BST-1805)', () => {
  beforeEach(() => {
    toast.mockClear();
    setModelsEnabled.mockReset();
    db = { query: vi.fn() };
  });

  it('resolves committed with the prior states once the single write commits', async () => {
    const previous = new Map([
      ['a', false],
      ['b', true],
    ]);
    setModelsEnabled.mockResolvedValue(previous);
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a', 'b'], true);
    });
    expect(outcome).toEqual({ committed: true, previous });
    expect(setModelsEnabled).toHaveBeenCalledTimes(1);
    expect(setModelsEnabled).toHaveBeenCalledWith(db, ['a', 'b'], true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('resolves uncommitted and toasts when the write is rejected', async () => {
    setModelsEnabled.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a', 'b'], false);
    });
    expect(outcome).toEqual({ committed: false });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'disk full',
        title: 'Could not disable 2 models',
        variant: 'destructive',
      })
    );
  });

  it('refuses without writing when the database is not ready', async () => {
    db = null;
    const { result } = renderHook(() => useModelToggle());
    let outcome: ModelBulkToggleOutcome | undefined;
    await act(async () => {
      outcome = await result.current.toggleMany(['a'], true);
    });
    expect(outcome).toEqual({ committed: false });
    expect(setModelsEnabled).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('marks every id busy while the write is in flight and releases them after', async () => {
    let finish: (value: ReadonlyMap<string, boolean>) => void = () => undefined;
    setModelsEnabled.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() => useModelToggle());
    let pending: Promise<ModelBulkToggleOutcome> | undefined;
    act(() => {
      pending = result.current.toggleMany(['a', 'b'], true);
    });
    expect([...result.current.busyModelIds].sort()).toEqual(['a', 'b']);
    await act(async () => {
      finish(new Map());
      await pending;
    });
    expect(result.current.busyModelIds.size).toBe(0);
  });
});
