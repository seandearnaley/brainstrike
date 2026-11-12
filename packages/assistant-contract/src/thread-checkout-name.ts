/**
 * ADR-0034: what a thread's checkout is called. One rule for every surface that
 * names it: the Threads panel's checkout chip, the composer's where-control and
 * the Explorer's header.
 *
 * - A thread in a worktree: the worktree's folder name (`swift-badger`).
 * - Any other thread: `Local`, the folder itself. A folder outside git is a
 *   project with one checkout (decision 1), so it is `Local` too.
 */

/** The checkout that is the project's own folder. */
export const LOCAL_CHECKOUT_NAME = 'Local';

/** `/managed/app/bright-fox` → `bright-fox`, on either separator; undefined for a path that names no folder (`/`). */
export function pathFolderName(path: string): string | undefined {
  return path.split(/[\\/]/u).findLast(Boolean);
}

/** `Local`, or the worktree's folder name. A worktree path that names no folder is shown as it is. */
export function checkoutName(worktreePath: string | null | undefined): string {
  if (!worktreePath) {
    return LOCAL_CHECKOUT_NAME;
  }
  return pathFolderName(worktreePath) ?? worktreePath;
}
