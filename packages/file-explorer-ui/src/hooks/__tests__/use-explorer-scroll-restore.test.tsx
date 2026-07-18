/**
 * Unit coverage for the CAPTURE half of session scroll restore: a scroll on the
 * active container writes the offset to the store, and the inner forest scroller
 * wins over the outer root when present. The RESTORE half depends on async store
 * hydration + real layout height and is proven end-to-end in the desktop e2e
 * (explorer-scroll-restore.desktop.test.ts).
 */
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render } from '@testing-library/react';
import type { ReactNode, RefObject } from 'react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
} from '../../shell/file-explorer-provider';
import { useExplorerScrollRestore } from '../use-explorer-scroll-restore';

afterEach(() => {
  vi.restoreAllMocks();
});

type Store = ReturnType<typeof useFileExplorerStoreContext>;

function makeScrollRoot(scrollHeight: number, clientHeight = 100): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  return el;
}

function Harness({
  rootEl,
  onStore,
}: {
  rootEl: HTMLElement;
  onStore: (store: Store) => void;
}): ReactNode {
  const store = useFileExplorerStoreContext();
  onStore(store);
  const ref = useRef<HTMLElement | null>(rootEl) as RefObject<HTMLElement | null>;
  useExplorerScrollRestore(ref);
  return null;
}

function renderHarness(rootEl: HTMLElement): { store: Store } {
  let store!: Store;
  render(
    <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
      <Harness
        onStore={(s) => {
          store = s;
        }}
        rootEl={rootEl}
      />
    </FileExplorerProvider>
  );
  return { store };
}

describe('useExplorerScrollRestore capture', () => {
  it('writes the active container scroll offset into the store (trailing-debounced)', async () => {
    vi.useFakeTimers();
    try {
      const rootEl = makeScrollRoot(1000);
      const { store } = renderHarness(rootEl);
      // No persisted offset (default 0) → restore resolves immediately, capture on.
      await act(async () => {
        await Promise.resolve();
      });

      rootEl.scrollTop = 275;
      act(() => {
        rootEl.dispatchEvent(new Event('scroll'));
      });
      // Debounced: not committed until the trailing timer fires.
      expect(store.getState().explorerScrollTop).toBe(0);

      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(store.getState().explorerScrollTop).toBe(275);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces a continuous scroll to a single commit of the resting position', async () => {
    vi.useFakeTimers();
    try {
      const rootEl = makeScrollRoot(1000);
      const { store } = renderHarness(rootEl);
      await act(async () => {
        await Promise.resolve();
      });
      const setSpy = vi.spyOn(store.getState(), 'setExplorerScrollTop');

      act(() => {
        for (const top of [40, 120, 260, 410]) {
          rootEl.scrollTop = top;
          rootEl.dispatchEvent(new Event('scroll'));
          vi.advanceTimersByTime(50); // faster than the debounce window
        }
        vi.advanceTimersByTime(250); // let the trailing timer fire
      });

      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(store.getState().explorerScrollTop).toBe(410);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the inner forest scroller (via the capture-phase listener), not the root', async () => {
    vi.useFakeTimers();
    try {
      const rootEl = makeScrollRoot(200, 100);
      const forest = makeScrollRoot(1000, 100);
      forest.setAttribute('data-testid', 'forest-sections-scroll');
      rootEl.appendChild(forest);

      const { store } = renderHarness(rootEl);
      await act(async () => {
        await Promise.resolve();
      });

      // A scroll on the OUTER root is ignored (forest is the active container).
      rootEl.scrollTop = 50;
      act(() => {
        rootEl.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(250);
      });
      expect(store.getState().explorerScrollTop).toBe(0);

      // A scroll on the inner forest container is captured.
      forest.scrollTop = 333;
      act(() => {
        forest.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(250);
      });
      expect(store.getState().explorerScrollTop).toBe(333);
    } finally {
      vi.useRealTimers();
    }
  });
});
