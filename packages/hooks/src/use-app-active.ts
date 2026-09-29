import { createLogger } from '@brainstrike/logging';
import { resolveWindowFocusBridge } from '@brainstrike/utils/window-focus-bridge';
import { useSyncExternalStore } from 'react';

const logger = createLogger('UseAppActive');

/**
 * Tracks whether the application window is "active" — both visible and focused.
 *
 * Combines the Page Visibility API (`document.visibilityState`) with focus to
 * detect when the user is not looking at the app. This is critical for pausing
 * expensive polling intervals when the app is idle in the background, especially
 * with `backgroundThrottling: false` which prevents Chromium from automatically
 * throttling timers.
 *
 * Where "focused" comes from depends on the platform, decided by CAPABILITY:
 * - Web: `document.hasFocus()`, re-read on window `focus`/`blur`.
 * - Desktop (the preload's `windowFocus` capability): the NATIVE window's focus.
 *   The renderer's own `document.hasFocus()` is false while keyboard focus sits
 *   in the browser pane's `WebContentsView` or in docked DevTools, though the
 *   BrainStrike window is still the focused OS window (BST-1864). Visibility
 *   still comes from `document.hidden`.
 *
 * The native value arrives asynchronously, so until the first one lands the
 * renderer's own reading stands in: a window that starts focused never flashes
 * inactive. Any value pushed meanwhile wins over the older initial read.
 *
 * @returns `true` when the window is focused and visible, `false` otherwise.
 */

const _windowFocusBridge = typeof document === 'undefined' ? null : resolveWindowFocusBridge();
/** `null`: the capability exists but has not delivered a value yet. */
let _nativeFocused: boolean | null = null;

function _readActive(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  if (document.hidden) {
    return false;
  }
  if (_windowFocusBridge === null) {
    return document.hasFocus();
  }
  return _nativeFocused ?? document.hasFocus();
}

let _active = _readActive();
const _listeners = new Set<() => void>();

function _update() {
  const next = _readActive();
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

if (_windowFocusBridge !== null) {
  // Subscribe BEFORE the initial read so no change can fall between the two.
  _windowFocusBridge.onChange((focused) => {
    _nativeFocused = focused;
    _update();
  });
  _windowFocusBridge.isFocused().then(
    (focused) => {
      // A pushed change is newer than this read, whatever order they arrive in.
      if (_nativeFocused === null) {
        _nativeFocused = focused;
        _update();
      }
    },
    (error: unknown) => {
      logger.error(
        'Initial native window focus read failed; using the renderer reading until a focus change is pushed',
        error
      );
    }
  );
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
