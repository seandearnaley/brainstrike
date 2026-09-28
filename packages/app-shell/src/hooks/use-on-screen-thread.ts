/**
 * The ONE definition of "this thread's transcript is on screen" (BST-1845):
 *
 *   route === 'explorer'
 *     && the surface renders that thread's transcript
 *     && document.visibilityState === 'visible' && document.hasFocus()
 *
 * The last two terms are `useAppActive()`, the same condition the OS-notification
 * gate reads, so every completion is either "seen, no alert" or "unseen, alert if
 * enabled" — never both. Window focus is required, not just visibility: on
 * Windows and Linux a covered window still reports `visible`.
 *
 * The explorer surface stays MOUNTED but hidden on every other shell route, and
 * the transcript stays mounted in a background window, so neither mounted-ness
 * nor "is the active thread" can stand in for it. The surface that renders
 * transcripts computes the answer and publishes it here for the other readers
 * (the Threads panel); it feeds its OWN consumers from the value it computed this
 * render, never from the store, which lags one commit behind.
 */
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAppActive } from '@brainstrike/hooks';
import { useEffect } from 'react';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';

/** The thread whose transcript is on screen right now, or `null`. */
export function useOnScreenThreadId(): string | null {
  return useOnScreenThreadStore((state) => state.onScreenThreadId);
}

/**
 * Computes the on-screen thread and publishes it for the other readers. Call it
 * exactly once, from the surface that renders transcripts, with the thread whose
 * transcript that surface is showing: `null` when it renders none — the database
 * is unavailable or failed, the thread list failed to load, or no thread is open.
 * (A thread list still LOADING with tabs open renders the active transcript, so
 * that thread is published.) A Threads panel mounted without that surface
 * therefore reports nothing on screen.
 *
 * RETURNS the identity computed this render. The store is written in a passive
 * effect, so in the render where a refresh lands together with a blur, a route
 * change or a tab switch, reading the store back would still yield the OUTGOING
 * thread next to the fresh completion — and stamp that completion as seen. The
 * publisher therefore uses this return value for its own unseen derivation and
 * stamping; the store is only the broadcast.
 *
 * While mounted it owns the value: a store drained under it (a factory reset
 * without a reload) is republished at once, not at the next route/focus/thread
 * change. It does not fight a non-null claim, so this cannot loop; there must
 * still be only one publisher. Unmounting withdraws the claim only if it is still
 * this publisher's.
 */
export function usePublishOnScreenThreadId(transcriptThreadId: string | null): string | null {
  const explorerRouteShowing = usePanelLayoutStore((state) => state.activeTab) === 'explorer';
  const appActive = useAppActive();
  const onScreenThreadId = explorerRouteShowing && appActive ? transcriptThreadId : null;

  useEffect(() => {
    const { getState, subscribe } = useOnScreenThreadStore;
    const claim = (): void => {
      if (getState().onScreenThreadId !== onScreenThreadId) {
        getState().setOnScreenThreadId(onScreenThreadId);
      }
    };
    claim();
    const unsubscribe = subscribe((state) => {
      if (state.onScreenThreadId === null) {
        claim();
      }
    });
    return () => {
      unsubscribe();
      if (onScreenThreadId !== null) {
        getState().releaseOnScreenThreadId(onScreenThreadId);
      }
    };
  }, [onScreenThreadId]);

  return onScreenThreadId;
}
