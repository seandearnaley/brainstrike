import * as React from 'react';

/**
 * Returns true when the keystroke originates from a text-entry surface
 * (input/textarea/contenteditable). The global ⌘K listener ignores those so
 * the shortcut never hijacks typing — mirrors the guard in
 * `collection-browser/search-mode-bar.tsx` and `tree-table/use-tree-keyboard.ts`.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return target.isContentEditable;
}

export interface CommandPaletteHotkeyOptions {
  /** Invoked when ⌘K (or Ctrl+K) fires outside a text-entry surface. */
  readonly onOpen: () => void;
}

/**
 * Binds a document-level ⌘K / Ctrl+K listener that opens the command palette on
 * web AND desktop. The listener:
 *  - ignores the keystroke while a text input / textarea / contenteditable is
 *    focused (so it never swallows a literal "k"),
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
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (event.key.toLowerCase() !== 'k') {
        return;
      }
      if (isTextEntryTarget(event.target)) {
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
