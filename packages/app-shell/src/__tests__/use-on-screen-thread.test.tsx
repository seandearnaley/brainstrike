import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOnScreenThreadId, usePublishOnScreenThreadId } from '../hooks/use-on-screen-thread';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';
import {
  blurWindow,
  focusWindow,
  hideDocument,
  resetWindowActivity,
} from './window-activity-test-support';

/**
 * BST-1845: the ONE definition of "this thread's transcript is on screen".
 *
 *   route === 'explorer' && the surface renders the thread's transcript
 *     && document.visibilityState === 'visible' && document.hasFocus()
 *
 * The surface that renders transcripts publishes it; every unseen derivation
 * reads it back. These tests drive the publisher with the REAL panel-layout
 * store (the route) and the REAL `useAppActive` (visibility + focus).
 */
function onScreenThreadId(): string | null {
  return useOnScreenThreadStore.getState().onScreenThreadId;
}

beforeEach(() => {
  usePanelLayoutStore.setState({ activeTab: 'explorer' });
});

afterEach(() => {
  resetWindowActivity();
  usePanelLayoutStore.setState({ activeTab: 'explorer' });
});

describe('usePublishOnScreenThreadId', () => {
  it('publishes the transcript thread while the explorer route shows in an active window', () => {
    focusWindow();

    renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });

    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('publishes nothing while Settings (or any other route) covers the explorer surface', () => {
    focusWindow();
    renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    expect(onScreenThreadId()).toBe('thread-a');

    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'settings' });
    });
    expect(onScreenThreadId()).toBeNull();

    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'explorer' });
    });
    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('publishes nothing while the window is blurred, and again on refocus', () => {
    focusWindow();
    renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });

    blurWindow();
    expect(onScreenThreadId()).toBeNull();

    focusWindow();
    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('publishes nothing while the document is hidden, and again once it shows', () => {
    focusWindow();
    renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });

    hideDocument();
    expect(onScreenThreadId()).toBeNull();

    focusWindow();
    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('publishes nothing when the surface renders no transcript (loading, error, no open tab)', () => {
    focusWindow();

    renderHook(() => {
      usePublishOnScreenThreadId(null);
    });

    expect(onScreenThreadId()).toBeNull();
  });

  it('follows the transcript from one thread to the next', () => {
    focusWindow();
    const { rerender } = renderHook(
      (threadId: string | null) => {
        usePublishOnScreenThreadId(threadId);
      },
      { initialProps: 'thread-a' as string | null }
    );
    expect(onScreenThreadId()).toBe('thread-a');

    rerender('thread-b');

    expect(onScreenThreadId()).toBe('thread-b');
  });

  // A surface that unmounts shows nothing: a Threads panel left mounted alone
  // must not keep claiming the last transcript is on screen.
  it('withdraws the claim when the transcript surface unmounts', () => {
    focusWindow();
    const { unmount } = renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    expect(onScreenThreadId()).toBe('thread-a');

    unmount();

    expect(onScreenThreadId()).toBeNull();
  });
});

describe('useOnScreenThreadId', () => {
  it('reads what the transcript surface published', () => {
    const { result } = renderHook(() => useOnScreenThreadId());
    expect(result.current).toBeNull();

    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-b');
    });

    expect(result.current).toBe('thread-b');
  });
});
