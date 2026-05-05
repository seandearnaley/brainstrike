import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the application window is "active" — both visible and focused.
 *
 * Combines the Page Visibility API (`document.visibilityState`) with window
 * `focus`/`blur` events to detect when the user is not looking at the app.
 * This is critical for pausing expensive polling intervals when the app is idle
 * in the background, especially with `backgroundThrottling: false` which prevents
 * Chromium from automatically throttling timers.
 *
 * @returns `true` when the window is focused and visible, `false` otherwise.
 */

let _active = typeof document === 'undefined' ? true : !document.hidden && document.hasFocus();
const _listeners = new Set<() => void>();

function _update() {
  const next = typeof document === 'undefined' ? true : !document.hidden && document.hasFocus();
  if (next !== _active) {
    _active = next;
    for (const listener of _listeners) {
      listener();
    }
  }
}

// Attach global listeners once (module scope, idempotent).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', _update);
  window.addEventListener('focus', _update);
  window.addEventListener('blur', _update);
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return _active;
}

function getServerSnapshot(): boolean {
  return true;
}

export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Non-hook version for use in setInterval callbacks.
 * Returns the current active state without requiring React context.
 */
export function isAppActive(): boolean {
  return _active;
}
