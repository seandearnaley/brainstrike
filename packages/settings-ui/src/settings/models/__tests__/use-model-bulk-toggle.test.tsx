import { act, renderHook } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBulkToggleOutcome } from '../use-model-toggle';

const toast = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));

import { useModelBulkToggle } from '../use-model-bulk-toggle';

const toggleMany =
  vi.fn<(modelIds: readonly string[], enabled: boolean) => Promise<ModelBulkToggleOutcome>>();

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
  });

  it('writes once and offers Undo on success', async () => {
    toggleMany.mockResolvedValue({
      committed: true,
      previous: new Map([
        ['a', true],
        ['b', true],
      ]),
    });
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
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
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
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
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    await act(async () => {
      await result.current({ enabled: true, modelIds: ['a', 'b', 'c'], scopeLabel: 'Anthropic' });
    });
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
    const { result } = renderHook(() => useModelBulkToggle(toggleMany));
    await act(async () => {
      await result.current({ enabled: false, modelIds: ['a'], scopeLabel: 'OpenAI' });
    });
    toggleMany.mockResolvedValue({ committed: false });

    act(() => undoActionOf(0)());

    await vi.waitFor(() => {
      expect(toggleMany).toHaveBeenCalledTimes(2);
    });
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
