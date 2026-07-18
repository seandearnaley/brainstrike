/**
 * Session scroll restore for the file explorer.
 *
 * Captures the explorer scroll container's vertical offset (persisted,
 * workspace-global, see FileExplorerState.explorerScrollTop) and restores it on
 * the next boot so a session resumes where the user left off. File-tree rows are
 * fixed height, so a raw pixel offset restores deterministically once the same
 * expansions are present.
 *
 * One capture-phase scroll listener on the panel's outer scroll root serves BOTH
 * layouts: scroll events do not bubble, but ancestors still receive them in the
 * capture phase, so a listener on the root catches the single-root scroller (the
 * root itself) AND the forest's inner `forest-sections-scroll` container.
 *
 * Ordering is race-free: capture stays DISABLED until restore resolves, so a
 * layout reset that scrolls to 0 during boot cannot clobber the persisted target
 * before it is applied. Restore waits for store hydration (the persisted offset
 * lands asynchronously) and then retries across frames until the content is tall
 * enough for the offset to stick.
 */
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';

const MAX_RESTORE_FRAMES = 90;

interface PersistApiLike {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => () => void;
}

function getPersistApi(store: unknown): PersistApiLike | undefined {
  const candidate = (store as { persist?: PersistApiLike }).persist;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

export function useExplorerScrollRestore(rootRef: RefObject<HTMLElement | null>): void {
  const store = useFileExplorerStoreContext();
  const hasRestoredRef = useRef(false);
  const captureEnabledRef = useRef(false);
  const throttleRafRef = useRef<number | null>(null);

  // The ACTIVE scroll container, in priority order:
  //  1. forest mode → the shared inner `forest-sections-scroll` (external scroll)
  //  2. single-root → the TreeTable's own viewport (it owns scrolling there)
  //  3. fallback → the outer root itself
  // Forest sections' own viewports are overflow-visible (external scroll), so
  // (1) is checked first and (2) only resolves in single-root mode.
  const getScrollEl = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) {
      return null;
    }
    return (
      root.querySelector<HTMLElement>('[data-testid="forest-sections-scroll"]') ??
      root.querySelector<HTMLElement>('[data-testid="tree-table-viewport"]') ??
      root
    );
  }, [rootRef]);

  // Capture (rAF-throttled). Disabled until restore resolves.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onScroll = (event: Event): void => {
      if (!captureEnabledRef.current) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || target !== getScrollEl()) {
        return;
      }
      if (throttleRafRef.current !== null) {
        return;
      }
      throttleRafRef.current = requestAnimationFrame(() => {
        throttleRafRef.current = null;
        store.getState().setExplorerScrollTop(target.scrollTop);
      });
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll, { capture: true });
      if (throttleRafRef.current !== null) {
        cancelAnimationFrame(throttleRafRef.current);
        throttleRafRef.current = null;
      }
    };
  }, [rootRef, getScrollEl, store]);

  // Restore, once, after hydration.
  useEffect(() => {
    let cancelled = false;

    const enableCapture = (): void => {
      hasRestoredRef.current = true;
      captureEnabledRef.current = true;
    };

    const run = (): void => {
      if (cancelled || hasRestoredRef.current) {
        return;
      }
      const target = store.getState().explorerScrollTop;
      if (target <= 0) {
        // Nothing to restore (user was at the top) — start capturing now.
        enableCapture();
        return;
      }

      let attempts = 0;
      const tryRestore = (): void => {
        if (cancelled) {
          return;
        }
        const el = getScrollEl();
        if (el && el.scrollHeight - el.clientHeight >= target) {
          el.scrollTop = target;
          enableCapture();
          return;
        }
        if (attempts < MAX_RESTORE_FRAMES) {
          attempts += 1;
          requestAnimationFrame(tryRestore);
          return;
        }
        // Content never grew tall enough (e.g. fewer rows than last session):
        // land as close as possible, then hand off to capture.
        if (el) {
          el.scrollTop = target;
        }
        enableCapture();
      };
      requestAnimationFrame(tryRestore);
    };

    const persist = getPersistApi(store);
    if (persist?.hasHydrated?.() ?? true) {
      run();
      return () => {
        cancelled = true;
      };
    }
    const unsubscribe = persist?.onFinishHydration?.(run);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [store, getScrollEl]);
}
