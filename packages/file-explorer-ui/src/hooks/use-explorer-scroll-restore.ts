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
 * TreeTable viewport) AND the forest's inner `forest-sections-scroll` container.
 *
 * Persistence is trailing-DEBOUNCED, not per-frame: each `set()` re-serializes
 * the whole partialized snapshot (every folder's expansions/selections), so a
 * continuous scroll must not commit ~60×/sec. Only the resting position matters
 * for restore.
 *
 * Ordering is race-free: capture stays DISABLED until restore resolves, so a
 * layout reset that scrolls to 0 during boot cannot clobber the persisted target
 * before it is applied. Restore waits for store hydration (the persisted offset
 * lands asynchronously) and then re-attempts as the tree grows (a slow
 * permission-restore / worker load can mount rows well after first paint) until
 * the scroller is tall enough for the offset to stick, with a generous deadline
 * backstop so capture is never wedged off forever.
 */
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';

/** Trailing debounce for the persisted scroll commit. */
const SCROLL_COMMIT_DEBOUNCE_MS = 200;
/** Backstop: give up waiting for the tree to grow after this long. */
const RESTORE_DEADLINE_MS = 10_000;

interface PersistApiLike {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => () => void;
}

function getPersistApi(store: unknown): PersistApiLike | undefined {
  const candidate = (store as { persist?: PersistApiLike }).persist;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

interface RestoreControllerOptions {
  getScrollEl: () => HTMLElement | null;
  getTarget: () => number;
  rootRef: RefObject<HTMLElement | null>;
}

/**
 * Restore orchestration extracted from the hook effect: apply the persisted
 * offset once the active scroller is tall enough, re-attempting as the tree
 * mounts/grows (Mutation/Resize observers) with a deadline backstop. `start`
 * returns synchronously true when restore already resolved (target ≤ 0 or the
 * offset applied immediately); otherwise observers/deadline resolve later and
 * call `onResolved`. Returns a cleanup for the observers/timer.
 */
function startScrollRestore(options: RestoreControllerOptions, onResolved: () => void): () => void {
  const { getScrollEl, getTarget, rootRef } = options;
  let resolved = false;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };
  const resolve = (): void => {
    if (resolved) {
      return;
    }
    resolved = true;
    cleanup();
    onResolved();
  };

  // Apply the offset iff the scroller can hold it; returns whether we resolved.
  const tryApply = (): boolean => {
    if (resolved) {
      return true;
    }
    const target = getTarget();
    if (target <= 0) {
      resolve();
      return true;
    }
    const el = getScrollEl();
    if (el && el.scrollHeight - el.clientHeight >= target) {
      el.scrollTop = target;
      resolve();
      return true;
    }
    return false;
  };

  if (tryApply()) {
    return cleanup;
  }

  // Re-attempt as the tree mounts/grows. The virtualizer sets total height on a
  // spacer (style mutation) and mounts windowed rows (childList).
  const root = rootRef.current;
  if (root) {
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(() => tryApply());
      mutationObserver.observe(root, {
        attributeFilter: ['style'],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => tryApply());
      resizeObserver.observe(root);
    }
  }

  // Backstop: never wedge capture off — best-effort apply, then hand over.
  deadlineTimer = setTimeout(() => {
    const el = getScrollEl();
    if (el) {
      el.scrollTop = getTarget();
    }
    resolve();
  }, RESTORE_DEADLINE_MS);

  return cleanup;
}

export function useExplorerScrollRestore(rootRef: RefObject<HTMLElement | null>): void {
  const store = useFileExplorerStoreContext();
  const hasRestoredRef = useRef(false);
  const captureEnabledRef = useRef(false);

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

  // Capture: trailing-debounced persisted commit. Disabled until restore resolves.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingOffset: number | null = null;

    const commit = (): void => {
      commitTimer = null;
      if (pendingOffset !== null) {
        store.getState().setExplorerScrollTop(pendingOffset);
        pendingOffset = null;
      }
    };
    const onScroll = (event: Event): void => {
      if (!captureEnabledRef.current) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || target !== getScrollEl()) {
        return;
      }
      pendingOffset = target.scrollTop;
      if (commitTimer !== null) {
        clearTimeout(commitTimer);
      }
      commitTimer = setTimeout(commit, SCROLL_COMMIT_DEBOUNCE_MS);
    };

    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll, { capture: true });
      if (commitTimer !== null) {
        clearTimeout(commitTimer);
        // Flush the last position on unmount so it is not lost.
        commit();
      }
    };
  }, [rootRef, getScrollEl, store]);

  // Restore, once, after hydration — retrying as the tree grows.
  useEffect(() => {
    let cleanupController: (() => void) | null = null;

    const run = (): void => {
      if (hasRestoredRef.current || cleanupController) {
        return;
      }
      cleanupController = startScrollRestore(
        {
          getScrollEl,
          getTarget: () => store.getState().explorerScrollTop,
          rootRef,
        },
        () => {
          hasRestoredRef.current = true;
          captureEnabledRef.current = true;
        }
      );
    };

    const persist = getPersistApi(store);
    let unsubscribe: (() => void) | undefined;
    if (persist?.hasHydrated?.() ?? true) {
      run();
    } else {
      unsubscribe = persist?.onFinishHydration?.(run);
      // Race guard: hydration may complete between the check above and the
      // subscribe, in which case onFinishHydration never fires.
      if (persist?.hasHydrated?.()) {
        run();
      }
    }
    return () => {
      unsubscribe?.();
      cleanupController?.();
    };
  }, [store, getScrollEl, rootRef]);
}
