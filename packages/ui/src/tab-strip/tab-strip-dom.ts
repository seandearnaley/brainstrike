/** DOM lookups shared by the strip's focus and menu hooks. */

export function findTab(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>('[role="tab"][data-strip-tab-id]')) {
    if (element.dataset['stripTabId'] === id) {
      return element;
    }
  }
  return null;
}

/** The committed selected tab, pinned or scroll: after a close, the consumer's new active tab. */
export function findSelectedTab(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
}

/** Focus was dropped: nothing focused, `body`, or an element no longer in the document. */
export function isFocusLost(): boolean {
  const focused = document.activeElement;
  return focused === null || focused === document.body || !focused.isConnected;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
  );
}

export function revealTab(tab: HTMLElement | null, smooth: boolean): void {
  const shell = tab?.closest<HTMLElement>('[data-slot="tab-shell"]');
  // scrollIntoView is absent from unit-test DOM shims only.
  if (!shell || typeof shell.scrollIntoView !== 'function') {
    return;
  }
  shell.scrollIntoView({
    behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    block: 'nearest',
    inline: 'nearest',
  });
}

/** Focuses the first enabled trailing control; returns whether one existed. */
export function focusFirstTrailingControl(trailing: HTMLElement | null): boolean {
  const control = trailing?.querySelector<HTMLElement>('button:not([disabled])');
  control?.focus();
  return control !== undefined && control !== null;
}
