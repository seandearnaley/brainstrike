/**
 * BST-1990: a quiet marker on an Explorer folder header when the folder is not
 * one of the selected thread's. The thread's folders come from the workspace
 * bar (see `thread-folder-scope-store`); with no binding, every folder is in
 * the thread's scope and nothing is marked.
 */
import type { ReactElement } from 'react';
import { useThreadFolderScopeStore } from '../thread-folder-scope-store';

export function ThreadScopeMarker({ rootId }: { readonly rootId: string }): ReactElement | null {
  const outside = useThreadFolderScopeStore(
    (state) => state.scope !== null && !state.scope.rootIds.includes(rootId)
  );
  if (!outside) {
    return null;
  }
  return (
    <span
      className="text-muted-foreground shrink-0 text-[10px] whitespace-nowrap"
      data-testid={`thread-scope-marker-${rootId}`}
      title="The selected thread can't use this folder until it is added to the thread"
    >
      Not in this thread
    </span>
  );
}
