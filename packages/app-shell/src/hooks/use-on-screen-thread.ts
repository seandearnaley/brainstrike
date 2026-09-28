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
 * transcripts publishes the answer here; the Threads panel, the thread strip and
 * the watermark stamper read it back, so they cannot disagree.
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
 * Publishes the on-screen thread. Call it exactly once, from the surface that
 * renders transcripts, with the thread whose transcript that surface is showing
 * (`null` while it shows a loading or error state, or has no open tab). A
 * Threads panel mounted without that surface therefore reports nothing on
 * screen. The claim is withdrawn when the surface unmounts.
 */
export function usePublishOnScreenThreadId(transcriptThreadId: string | null): void {
  const explorerRouteShowing = usePanelLayoutStore((state) => state.activeTab) === 'explorer';
  const appActive = useAppActive();
  const setOnScreenThreadId = useOnScreenThreadStore((state) => state.setOnScreenThreadId);
  const onScreenThreadId = explorerRouteShowing && appActive ? transcriptThreadId : null;

  useEffect(() => {
    setOnScreenThreadId(onScreenThreadId);
    return () => setOnScreenThreadId(null);
  }, [onScreenThreadId, setOnScreenThreadId]);
}
