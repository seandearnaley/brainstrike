import { act } from '@testing-library/react';
import { type MockInstance, vi } from 'vitest';

/**
 * Drives `useAppActive` (`@brainstrike/hooks`) the way a browser does. That hook
 * caches `!document.hidden && document.hasFocus()` at module scope and re-reads
 * it ONLY on `visibilitychange` / `focus` / `blur`, so stubbing the document is
 * not enough: the event has to follow, inside `act`.
 *
 * jsdom starts every document unfocused, so an on-screen test must call
 * `focusWindow()` first, and every suite that does must call
 * `resetWindowActivity()` in `afterEach` so the module-scope cache goes back to
 * its jsdom default for the next test.
 */
let hasFocusSpy: MockInstance<() => boolean> | null = null;

function setWindowActivity({
  focused,
  visible,
}: {
  readonly focused: boolean;
  readonly visible: boolean;
}): void {
  hasFocusSpy ??= vi.spyOn(document, 'hasFocus');
  hasFocusSpy.mockReturnValue(focused);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  });
}

/** Foreground window: visible and focused. */
export function focusWindow(): void {
  setWindowActivity({ focused: true, visible: true });
}

/** Visible but not focused: another window is in front (still `visible` on Windows/Linux). */
export function blurWindow(): void {
  setWindowActivity({ focused: false, visible: true });
}

/** Hidden document: minimised, or a background tab. It reports no focus either. */
export function hideDocument(): void {
  setWindowActivity({ focused: false, visible: false });
}

/** Back to jsdom's defaults, and the `useAppActive` cache with them. */
export function resetWindowActivity(): void {
  blurWindow();
  Reflect.deleteProperty(document, 'hidden');
  Reflect.deleteProperty(document, 'visibilityState');
  hasFocusSpy?.mockRestore();
  hasFocusSpy = null;
}
