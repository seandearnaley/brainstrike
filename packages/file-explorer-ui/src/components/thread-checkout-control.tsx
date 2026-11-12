/**
 * ADR-0034 decision 3: on the Explorer's header of the folder the active thread works in, the
 * control that changes where it works. It opens the composer's where-control (app-shell's
 * `changeCheckout`), so Local, the repository's worktrees, New worktree and Archive act through
 * the thread binding, their one writer, and never through a second menu here.
 */
import { ChevronsUpDown } from 'lucide-react';
import type { ReactElement } from 'react';
import { useRootCheckoutChange } from '../shell/thread-checkout-context';

export function ThreadCheckoutControl({
  rootId,
}: {
  readonly rootId: string | null;
}): ReactElement | null {
  const changeCheckout = useRootCheckoutChange(rootId);
  if (changeCheckout === null) {
    return null;
  }
  return (
    <button
      aria-label="Change where this thread works"
      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 cursor-pointer rounded p-1 focus-visible:ring-1 focus-visible:outline-hidden"
      data-testid="explorer-thread-checkout-control"
      onClick={changeCheckout}
      title="Change where this thread works"
      type="button"
    >
      <ChevronsUpDown aria-hidden="true" className="size-3" />
    </button>
  );
}
