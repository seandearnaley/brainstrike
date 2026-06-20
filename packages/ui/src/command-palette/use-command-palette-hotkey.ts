import * as React from 'react';

/**
 * True on macOS, where the command-palette accelerator is ⌘K (metaKey). Mirrors
 * the existing platform check in `file-explorer-ui` `revealLabel()` —
 * `navigator.platform` startsWith 'mac' — since the codebase has no shared
 * platform util. SSR-safe (no `navigator` ⇒ treated as non-mac).
 */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return navigator.platform.toLowerCase().startsWith('mac');
}

/**
 * True when the event is the platform command-palette accelerator:
 *  - macOS: ⌘K (metaKey, NOT ctrlKey — so the native Ctrl+K "kill-to-end-of-line"
 *    binding in text inputs is never hijacked),
 *  - Windows/Linux: Ctrl+K.
 * The matched modifier must be the platform one (we reject the cross-modifier so
 * macOS Ctrl+K and Windows ⌘K do not open the palette).
 */
function isCommandPaletteAccelerator(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'k') {
    return false;
  }
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export interface CommandPaletteHotkeyOptions {
  /** Invoked when the platform ⌘K / Ctrl+K accelerator fires. */
  readonly onOpen: () => void;
}

/**
 * Binds a document-level command-palette accelerator (⌘K on macOS, Ctrl+K on
 * Windows/Linux) that opens the palette on web AND desktop. The listener:
 *  - matches ONLY the platform accelerator (a non-character meta-chord), so it
 *    is safe to fire even when a text input/textarea/contenteditable is focused
 *    — this matches the desktop app-menu Cmd+K accelerator exactly (no web vs
 *    desktop divergence) and standard command-palette UX (VS Code / Linear),
 *  - does NOT match macOS Ctrl+K, leaving the native kill-to-end-of-line binding
 *    intact,
 *  - respects `event.defaultPrevented` (a nearer handler already claimed it),
 *  - `preventDefault()`s and calls `onOpen()` otherwise,
 *  - removes itself on unmount.
 *
 * Mount this ONLY in the visible-UI root so hidden hosts (embedding/llm/chunking
 * renderers) never bind it — they never mount the root layout, so this is
 * structurally gated rather than role-checked here.
 */
export function useCommandPaletteHotkey({ onOpen }: CommandPaletteHotkeyOptions): void {
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      if (!isCommandPaletteAccelerator(event)) {
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
