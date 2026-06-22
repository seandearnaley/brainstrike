/**
 * Shared platform-accelerator detection for the palette hotkeys (⌘K command
 * palette, ⌘P quick-open). One definition so both keys branch identically:
 *  - macOS: ⌘<key> (metaKey, NOT ctrlKey — so a native Ctrl-chord in a text
 *    input is never hijacked),
 *  - Windows/Linux: Ctrl+<key> (ctrlKey, NOT metaKey).
 * The matched modifier must be the platform one (the cross-modifier is rejected
 * so macOS Ctrl+<key> and Windows ⌘<key> never fire).
 */

/**
 * True on macOS. Mirrors the existing platform check in `file-explorer-ui`
 * `revealLabel()` — `navigator.platform` startsWith 'mac' — since the codebase
 * has no shared platform util. SSR-safe (no `navigator` ⇒ treated as non-mac).
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return navigator.platform.toLowerCase().startsWith('mac');
}

/**
 * True when the event is the platform accelerator for the given single
 * character key (case-insensitive). Used by the palette hotkeys.
 */
export function isPlatformAccelerator(event: KeyboardEvent, key: string): boolean {
  if (event.key.toLowerCase() !== key.toLowerCase()) {
    return false;
  }
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
