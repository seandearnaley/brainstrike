import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyToClipboard } from '../use-copy-to-clipboard';

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: clipboardMocks.writeText,
  }),
}));

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('routes copy through the shared clipboard service and marks success', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard({ copiedDuration: 1000 }));

    act(() => {
      result.current.copyToClipboard('const x = 1');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(clipboardMocks.writeText).toHaveBeenCalledWith('const x = 1');
    expect(result.current.isCopied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isCopied).toBe(false);
    vi.useRealTimers();
  });

  it('does not mark copied when the shared service reports failure', async () => {
    clipboardMocks.writeText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copyToClipboard('secret');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(clipboardMocks.writeText).toHaveBeenCalledWith('secret');
    expect(result.current.isCopied).toBe(false);
  });

  it('surfaces a failed outcome as isFailed and auto-resets on the same timer', async () => {
    vi.useFakeTimers();
    clipboardMocks.writeText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    });

    const { result } = renderHook(() => useCopyToClipboard({ copiedDuration: 1000 }));

    act(() => {
      result.current.copyToClipboard('secret');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isFailed).toBe(true);
    expect(result.current.isCopied).toBe(false);
    expect(result.current.status).toBe('failed');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isFailed).toBe(false);
    expect(result.current.status).toBe('idle');
    vi.useRealTimers();
  });

  it('surfaces a thrown write as isFailed (never a silent rejection)', async () => {
    clipboardMocks.writeText.mockRejectedValue(new Error('bridge exploded'));

    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copyToClipboard('secret');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isFailed).toBe(true);
    expect(result.current.isCopied).toBe(false);
  });

  it('a retry after failure can still succeed and reports copied', async () => {
    clipboardMocks.writeText.mockResolvedValueOnce({ error: 'nope', ok: false });

    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copyToClipboard('secret');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isFailed).toBe(true);

    clipboardMocks.writeText.mockResolvedValue({ ok: true });
    act(() => {
      result.current.copyToClipboard('secret');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isCopied).toBe(true);
    expect(result.current.isFailed).toBe(false);
  });

  it('ignores empty values', () => {
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copyToClipboard('');
    });

    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
  });

  it('clears the pending reset timer on unmount (no dangling timer, no late setState)', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useCopyToClipboard({ copiedDuration: 1000 }));

    act(() => {
      result.current.copyToClipboard('const x = 1');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isCopied).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    // The reset setTimeout must be cleared on unmount -- otherwise it fires
    // after unmount (late setState on an unmounted hook) and leaks a timer.
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});
