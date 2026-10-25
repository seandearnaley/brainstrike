import { lazy } from 'react';

/**
 * Lazy boundary for the Conversation Rewind confirm modal (BST-1115).
 *
 * The modal reuses the Changes surface's tree and diff panes, which is most of
 * the Changes chunk. `root-layout-content.tsx` is loaded by BOTH apps, so a
 * static import there would pull that whole subtree into the shell's entry
 * chunk — including on web, which has no Changes bridge and can never
 * open the modal at all. `ChangesSurface` is already lazy for exactly this
 * reason (`changes-page-content.tsx`); this keeps its second entry point on the
 * same side of the boundary.
 */
export const RewindConfirmDialogLazy = lazy(async () => {
  const module = await import('./rewind-confirm-dialog');
  return { default: module.RewindConfirmDialog };
});
