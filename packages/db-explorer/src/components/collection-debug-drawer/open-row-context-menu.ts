/**
 * Open the surrounding context menu for a row whose ONLY affordance is that
 * menu (the failed-embedding rows and the retrieval-result rows).
 *
 * Those rows are real `<button>`s, so Enter/Space must do something. Rather
 * than leaving the role over-promising — or demoting them to focusable `<div>`s,
 * which is its own a11y anti-pattern — activation replays the exact event a
 * right-click produces: a bubbling `contextmenu` at the row's own position.
 * The row's `onContextMenu` claims the target and Radix's trigger opens the
 * menu, so pointer and keyboard reach the identical code path.
 */
export function openRowContextMenu(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX: Math.round(rect.left + 8),
      clientY: Math.round(rect.bottom - 4),
    })
  );
}
