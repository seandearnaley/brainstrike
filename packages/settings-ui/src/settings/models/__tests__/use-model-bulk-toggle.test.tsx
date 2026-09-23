import { act, renderHook } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBulkToggleOutcome } from '../use-model-toggle';

const toast = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));

import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { useModelBulkToggle } from '../use-model-bulk-toggle';

const toggleMany =
  vi.fn<(modelIds: readonly string[], enabled: boolean) => Promise<ModelBulkToggleOutcome>>();

const NO_BUSY: ReadonlySet<string> = new Set<string>();

function storeModel(id: string, isEnabled: boolean): DbModel {
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

/** The store as it looks right after a bulk write set every id to `enabled`. */
function seedStore(ids: readonly string[], enabled: boolean): void {
  useModelRegistryStore.setState({ models: ids.map((id) => storeModel(id, enabled)) });
}

function undoActionOf(callIndex: number): () => void {
  const options = toast.mock.calls[callIndex]?.[0] as
    | { action?: ReactElement<{ onClick?: () => void }> }
    | undefined;
  const onClick = options?.action?.props.onClick;
  if (!onClick) {
    throw new Error(`toast #${callIndex} carries no Undo action`);
  }
  return onClick;
}

describe('useModelBulkToggle', () => {
  beforeEach(() => {
    toast.mockReset();
    toggleMany.mockReset();
    __resetModelRegistryStoreForTests();
  });

  it('writes once and offers Undo on success', async () => {
    toggleMany.mockResolvedValue({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle({ busyModelIds: NO_BUSY, toggleMany }));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current({
        enabled: false,
        modelIds: ['a', 'b'],
        scopeLabel: 'OpenRouter',
      });
    });
    expect(applied).toBe(true);
    expect(toggleMany).toHaveBeenCalledTimes(1);
    expect(toggleMany).toHaveBeenCalledWith(['a', 'b'], false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Disabled 2 OpenRouter models' })
    );
    expect(undoActionOf(0)).toBeTypeOf('function');
  });

  it('shows no success toast when the write is not committed', async () => {
    toggleMany.mockResolvedValue({ committed: false });
    const { result } = renderHook(() => useModelBulkToggle({ busyModelIds: NO_BUSY, toggleMany }));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current({ enabled: true, modelIds: ['a'], scopeLabel: 'OpenAI' });
    });
    expect(applied).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('Undo restores mixed prior states in at most two writes', async () => {
    toggleMany.mockResolvedValueOnce({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', false],
        ['c', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle({ busyModelIds: NO_BUSY, toggleMany }));
    await act(async () => {
      await result.current({ enabled: true, modelIds: ['a', 'b', 'c'], scopeLabel: 'Anthropic' });
    });
    seedStore(['a', 'b', 'c'], true);
    toggleMany.mockResolvedValue({ committed: true, previous: new Map() });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledTimes(2);
    });
    expect(toggleMany).toHaveBeenCalledTimes(3);
    expect(toggleMany).toHaveBeenNthCalledWith(2, ['a', 'c'], true);
    expect(toggleMany).toHaveBeenNthCalledWith(3, ['b'], false);
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Restored 3 models' }));
  });

  it('does not claim a restore when an Undo write fails', async () => {
    toggleMany.mockResolvedValueOnce({ committed: true, previous: new Map([['a', true]]) });
    const { result } = renderHook(() => useModelBulkToggle({ busyModelIds: NO_BUSY, toggleMany }));
    await act(async () => {
      await result.current({ enabled: false, modelIds: ['a'], scopeLabel: 'OpenAI' });
    });
    seedStore(['a'], false);
    toggleMany.mockResolvedValue({ committed: false });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toggleMany).toHaveBeenCalledTimes(2);
    });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('Undo leaves a row the user toggled after the bulk change, and says so', async () => {
    toggleMany.mockResolvedValueOnce({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle({ busyModelIds: NO_BUSY, toggleMany }));
    await act(async () => {
      await result.current({ enabled: false, modelIds: ['a', 'b'], scopeLabel: 'OpenAI' });
    });
    // The user re-enabled `b` by hand after the bulk disable.
    useModelRegistryStore.setState({ models: [storeModel('a', false), storeModel('b', true)] });
    toggleMany.mockResolvedValue({ committed: true, previous: new Map() });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledTimes(2);
    });
    expect(toggleMany).toHaveBeenCalledTimes(2);
    expect(toggleMany).toHaveBeenLastCalledWith(['a'], true);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Restored 1 of 2 models' })
    );
  });

  it('Undo skips an id with a write in flight', async () => {
    toggleMany.mockResolvedValueOnce({
      committed: true,
      previous: new Map([
        ['a', false],
        ['b', false],
      ]),
    });
    const { rerender, result } = renderHook(
      ({ busy }: { busy: ReadonlySet<string> }) =>
        useModelBulkToggle({ busyModelIds: busy, toggleMany }),
      { initialProps: { busy: NO_BUSY } }
    );
    await act(async () => {
      await result.current({ enabled: true, modelIds: ['a', 'b'], scopeLabel: 'OpenAI' });
    });
    seedStore(['a', 'b'], true);
    rerender({ busy: new Set(['a']) });
    toggleMany.mockResolvedValue({ committed: true, previous: new Map() });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledTimes(2);
    });
    expect(toggleMany).toHaveBeenLastCalledWith(['b'], false);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Restored 1 of 2 models' })
    );
  });
});
