import type { DirectoryHandle } from '@brainstrike/file-system';
import { createContext, type ReactNode, useContext } from 'react';
import { useFileExplorerStoreSelector } from './file-explorer-provider';

/**
 * ADR-0034: the active thread works in a worktree. `localRootId` is the open folder the
 * worktree was made from, when the thread recorded one.
 */
export interface ThreadCheckout {
  readonly localRootId: string | null;
  readonly worktreeRootId: string;
}

/**
 * file-explorer-ui does not know threads, so the layer that does (app-shell) names the active
 * thread's checkout. No provider, or a thread working in its local folder, is `null`.
 */
const ThreadCheckoutContext = createContext<ThreadCheckout | null>(null);

export function ThreadCheckoutProvider({
  checkout,
  children,
}: {
  checkout: ThreadCheckout | null;
  children: ReactNode;
}) {
  return (
    <ThreadCheckoutContext.Provider value={checkout}>{children}</ThreadCheckoutContext.Provider>
  );
}

export function useThreadCheckout(): ThreadCheckout | null {
  return useContext(ThreadCheckoutContext);
}

/**
 * The workspace's folders as the person sees them (ADR-0034). A managed worktree is never one
 * of the open folders: the active thread's worktree stands in for the folder it was made from,
 * and every other worktree is left out. The focused folder follows: a hidden one gives way to
 * the folder standing in its place.
 */
export function threadCheckoutView(
  handles: readonly DirectoryHandle[],
  focused: DirectoryHandle | null,
  checkout: ThreadCheckout | null
): { readonly focused: DirectoryHandle | null; readonly handles: DirectoryHandle[] } {
  const active = checkout
    ? handles.find((handle) => handle.rootId === checkout.worktreeRootId)
    : undefined;
  const visible = handles.flatMap((handle) => {
    if (handle.worktree) {
      return [];
    }
    return active && handle.rootId === checkout?.localRootId ? [active] : [handle];
  });
  if (active && !visible.includes(active)) {
    visible.push(active);
  }
  if (focused === null || visible.some((handle) => handle.rootId === focused.rootId)) {
    return { focused, handles: visible };
  }
  return { focused: active ?? visible[0] ?? null, handles: visible };
}

/**
 * The root ids of the folders the person sees, from the open folders' ids: the thread's worktree
 * takes its folder's place, or joins the end when that folder is not open. Selection spans
 * exactly these roots, so a hidden folder's selection never rides along.
 */
export function threadCheckoutRootIds(
  openRootIds: string[],
  checkout: ThreadCheckout | null
): string[] {
  if (checkout === null) {
    return openRootIds;
  }
  const { localRootId, worktreeRootId } = checkout;
  const ids = openRootIds.map((rootId) => (rootId === localRootId ? worktreeRootId : rootId));
  return ids.includes(worktreeRootId) ? ids : [...ids, worktreeRootId];
}

/**
 * The open folder a shown root acts for: itself, or, for the thread's worktree, the folder it
 * stands in for. `null` when the worktree stands in for no open folder. Disconnect and Main act
 * on this folder, so closing the section the person sees never unmounts the thread's checkout.
 */
export function openFolderFor(
  rootId: string,
  checkout: ThreadCheckout | null,
  openRootIds: readonly string[]
): string | null {
  if (checkout === null || rootId !== checkout.worktreeRootId) {
    return rootId;
  }
  const { localRootId } = checkout;
  return localRootId !== null && openRootIds.includes(localRootId) ? localRootId : null;
}

export function useOpenFolderFor(rootId: string): string | null {
  const checkout = useThreadCheckout();
  const openRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  return openFolderFor(rootId, checkout, openRootIds);
}
