import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // `null` is the surface's own "no transcript rendered" (a database or load-error
  // card, or no open tab). A thread list that is merely still loading WITH open
  // tabs renders its transcript, and is pinned at the workspace level.
  it('publishes nothing when the surface passes no transcript thread', () => {
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

// The publisher hands back the identity it computed THIS render, so the surface
// that publishes never has to read its own claim back from the store — which, in
// the render where a blur or route change lands, still holds the outgoing value.
describe('usePublishOnScreenThreadId return value', () => {
  it('returns the identity computed this render, before the store has been written', () => {
    focusWindow();
    const storeAtRender: Array<string | null> = [];

    const { result, rerender } = renderHook(
      (threadId: string | null) => {
        storeAtRender.push(onScreenThreadId());
        return usePublishOnScreenThreadId(threadId);
      },
      { initialProps: 'thread-a' as string | null }
    );
    expect(result.current).toBe('thread-a');

    rerender('thread-b');

    // The store still said 'thread-a' while this render already answered 'thread-b'.
    expect(storeAtRender.at(-1)).toBe('thread-a');
    expect(result.current).toBe('thread-b');
  });

  it('returns null, immediately, when the window blurs or the route leaves the explorer', () => {
    focusWindow();
    const { result } = renderHook(() => usePublishOnScreenThreadId('thread-a'));
    expect(result.current).toBe('thread-a');

    blurWindow();
    expect(result.current).toBeNull();

    focusWindow();
    expect(result.current).toBe('thread-a');

    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'settings' });
    });
    expect(result.current).toBeNull();

    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'explorer' });
    });
    expect(result.current).toBe('thread-a');
  });
});

// A reset-without-reload (factory reset) drains the store while the transcript
// surface stays mounted; nothing else would re-publish until the route, focus or
// thread changed.
describe('usePublishOnScreenThreadId when the store is drained under it', () => {
  it('republishes its claim after the store is reset', () => {
    focusWindow();
    renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    expect(onScreenThreadId()).toBe('thread-a');

    act(() => {
      useOnScreenThreadStore.getState().reset();
    });

    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('settles in one write and does not re-render: no effect loop', () => {
    focusWindow();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      usePublishOnScreenThreadId('thread-a');
    });
    const rendersAfterMount = renders;
    const writes = vi.fn();
    const unsubscribe = useOnScreenThreadStore.subscribe(writes);

    act(() => {
      useOnScreenThreadStore.getState().reset();
    });
    unsubscribe();

    // The drain, then exactly one republish. Nothing after that.
    expect(writes).toHaveBeenCalledTimes(2);
    expect(renders).toBe(rendersAfterMount);
  });

  it('does not write at all when the store already holds its claim', () => {
    focusWindow();
    const writes = vi.fn();
    const unsubscribe = useOnScreenThreadStore.subscribe(writes);

    const { rerender } = renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    rerender();
    rerender();
    unsubscribe();

    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while it has nothing to claim', () => {
    focusWindow();
    renderHook(() => {
      usePublishOnScreenThreadId(null);
    });
    const writes = vi.fn();
    const unsubscribe = useOnScreenThreadStore.subscribe(writes);

    act(() => {
      useOnScreenThreadStore.getState().reset();
    });
    unsubscribe();

    expect(writes).toHaveBeenCalledTimes(1);
    expect(onScreenThreadId()).toBeNull();
  });
});

// Unmount withdraws the claim only if it is still THIS publisher's: a claim that
// replaced it (a remounted surface) must survive the old one's cleanup.
describe('usePublishOnScreenThreadId cleanup', () => {
  it('withdraws its own claim when it unmounts', () => {
    focusWindow();
    const only = renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });

    only.unmount();

    expect(onScreenThreadId()).toBeNull();
  });

  it('leaves a claim that replaced its own alone when it unmounts', () => {
    focusWindow();
    const publisher = renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-b');
    });

    publisher.unmount();

    expect(onScreenThreadId()).toBe('thread-b');
  });

  // There must be one publisher; if a second ever mounts, the two must not
  // fight over the store (drain-only republish), and the survivor keeps its claim.
  it('does not fight a second publisher, and the survivor keeps its claim', () => {
    focusWindow();
    const first = renderHook(() => {
      usePublishOnScreenThreadId('thread-a');
    });
    const second = renderHook(() => {
      usePublishOnScreenThreadId('thread-b');
    });
    expect(onScreenThreadId()).toBe('thread-b');

    first.unmount();
    expect(onScreenThreadId()).toBe('thread-b');

    second.unmount();
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
