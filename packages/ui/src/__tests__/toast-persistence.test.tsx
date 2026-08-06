/**
 * Toast persistence through the REAL seam (BST-1164 review, finding: the raw
 * Radix provider's 5000ms default closed EVERY toast, making the rewind redo
 * toast — the only redo affordance — unreachable after 5s).
 *
 * Unlike `toaster.test.tsx` (which mocks `useToast`), this suite renders the
 * real store through the real `Toaster`/Radix tree under fake timers, because
 * the bug lived exactly in the store→Radix hand-off: the store believed
 * "no duration = persistent" while Radix's own default timer closed the toast
 * anyway. `persistent: true` must survive past the Radix default window;
 * a plain toast must still auto-dismiss on it.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../../src/toaster';
import { resetToastStore, toast } from '../../src/use-toast';

/** Radix ToastPrimitives.Provider's default `duration` (ms). */
const RADIX_DEFAULT_DURATION_MS = 5000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    resetToastStore();
  });
  vi.useRealTimers();
});

describe('toast persistence through the Radix provider default', () => {
  it('a persistent toast survives past the Radix default window; a plain toast auto-dismisses on it', () => {
    render(<Toaster />);
    act(() => {
      toast({ persistent: true, title: 'Persistent toast' });
      toast({ title: 'Plain toast' });
    });
    expect(screen.getByText('Persistent toast')).toBeInTheDocument();
    expect(screen.getByText('Plain toast')).toBeInTheDocument();

    // Well past the Radix provider default (plus the store's removal delay).
    act(() => {
      vi.advanceTimersByTime(RADIX_DEFAULT_DURATION_MS * 2);
    });

    expect(screen.getByText('Persistent toast')).toBeInTheDocument();
    expect(screen.queryByText('Plain toast')).not.toBeInTheDocument();
  });

  it('a persistent toast still dismisses on explicit request', () => {
    render(<Toaster />);
    let dismissToast: (() => void) | null = null;
    act(() => {
      dismissToast = toast({ persistent: true, title: 'Dismiss me' }).dismiss;
    });
    expect(screen.getByText('Dismiss me')).toBeInTheDocument();

    act(() => {
      dismissToast?.();
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });

  it('a store-scheduled duration still auto-dismisses ahead of the Radix default', () => {
    render(<Toaster />);
    act(() => {
      toast({ duration: 1000, title: 'Timed toast' });
    });
    expect(screen.getByText('Timed toast')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('Timed toast')).not.toBeInTheDocument();
  });

  it('throws on the contradictory persistent + numeric duration combination', () => {
    expect(() => toast({ duration: 4000, persistent: true, title: 'Contradiction' })).toThrow(
      /persistent/
    );
  });
});
