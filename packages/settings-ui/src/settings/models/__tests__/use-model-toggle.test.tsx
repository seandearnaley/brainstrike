import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
const toggleModel = vi.fn<(db: unknown, modelId: string, enabled: boolean) => Promise<void>>();
let db: unknown = { query: vi.fn() };

vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => db }));
vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector: (state: { toggleModel: typeof toggleModel }) => unknown) =>
    selector({ toggleModel }),
}));

import { useModelToggle } from '../use-model-toggle';

describe('useModelToggle', () => {
  beforeEach(() => {
    toast.mockClear();
    toggleModel.mockReset();
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
