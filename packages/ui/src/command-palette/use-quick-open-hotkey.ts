import * as React from 'react';
import { isPlatformAccelerator } from './platform-accelerator';

/**
 * True when the event is the platform quick-open accelerator:
 *  - macOS: ⌘P (metaKey, NOT ctrlKey),
 *  - Windows/Linux: Ctrl+P.
 * The matched modifier must be the platform one (the cross-modifier is rejected
 * so macOS Ctrl+P and Windows ⌘P never open quick-open).
 */
function isQuickOpenAccelerator(event: KeyboardEvent): boolean {
  return isPlatformAccelerator(event, 'p');
}

export interface QuickOpenHotkeyOptions {
  /** Invoked when the platform ⌘P / Ctrl+P accelerator fires. */
  readonly onOpen: () => void;
}

/**
 * Binds a document-level quick-open accelerator (⌘P on macOS, Ctrl+P on
 * Windows/Linux) that opens the file finder on web AND desktop. Mirrors
 * `useCommandPaletteHotkey` exactly (same platform branching, defaultPrevented
 * guard, preventDefault, cleanup):
 *  - matches ONLY the platform accelerator (a non-character meta-chord), so it
 *    is safe to fire even when a text input/textarea/contenteditable is focused
 *    — matching the desktop app-menu Cmd+P accelerator (no web/desktop
 *    divergence) and standard quick-open UX (VS Code / Sublime),
 *  - `preventDefault()`s, so the browser's native ⌘P print dialog does not open
 *    over the app — the same trade-off the app already makes for ⌘K vs the
 *    browser's native bindings (in-app accelerators win inside the app),
 *  - respects `event.defaultPrevented` (a nearer handler already claimed it),
 *  - removes itself on unmount.
 *
 * Mount this ONLY in the visible-UI root so hidden hosts (embedding/llm/chunking
 * renderers) never bind it — they never mount the root layout, so this is
 * structurally gated rather than role-checked here.
 */
export function useQuickOpenHotkey({ onOpen }: QuickOpenHotkeyOptions): void {
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      if (!isQuickOpenAccelerator(event)) {
        return;
      }
      event.preventDefault();
      onOpenRef.current();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
