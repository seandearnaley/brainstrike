/** Focus was dropped: nothing focused, `body`, or an element no longer in the document. */
export function isFocusLost(): boolean {
  const focused = document.activeElement;
  return focused === null || focused === document.body || !focused.isConnected;
}
