/**
 * BST-1932: the card that opened each host child, so returning to its parent
 * from the child's ancestry puts focus back where the person left it, as the
 * shipped delegated conversations do. Display focus only: never authority.
 */
const origins = new Map<
  string,
  { readonly element: WeakRef<HTMLElement>; readonly parentThreadId: string }
>();

export function rememberHostChildOrigin(
  childThreadId: string,
  parentThreadId: string,
  element: HTMLElement
): void {
  origins.set(childThreadId, { element: new WeakRef(element), parentThreadId });
}

/** Focus the card in `parentThreadId` that opened the child; false when there is none. */
export function focusHostChildOrigin(childThreadId: string, parentThreadId: string): boolean {
  const origin = origins.get(childThreadId);
  const element = origin?.element.deref();
  if (!(origin?.parentThreadId === parentThreadId && element?.isConnected)) {
    return false;
  }
  origins.delete(childThreadId);
  element.focus();
  return true;
}
