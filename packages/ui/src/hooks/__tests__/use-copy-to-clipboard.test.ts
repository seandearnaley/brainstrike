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

  it('ignores empty values', () => {
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copyToClipboard('');
    });

    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
  });
});
