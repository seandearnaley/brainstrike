/**
 * BST-1990: the selected thread's folders, for the Files cards, and a card's
 * one-shot "Add to this thread" request. The composer's workspace bar owns the
 * thread's folders and their one write path; the Files panel is mounted in a
 * different subtree, so it reads the folders here and asks the bar to add one.
 * Not a second source of truth: the scope mirrors the binding the bar shows,
 * and a request lasts only until the bar takes it.
 */
import { create } from 'zustand';

/** The selected thread and its folders, as the workspace bar shows them. */
export interface ThreadFolderScope {
  readonly rootIds: readonly string[];
  readonly threadId: string;
}

export interface ThreadFolderAddRequest {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
  readonly threadId: string;
}

export interface ThreadFolderScopeState {
  /** Returns and CLEARS the request when it targets `threadId`; else null. */
  readonly consumeAdd: (threadId: string) => ThreadFolderAddRequest | null;
  readonly pendingAdd: ThreadFolderAddRequest | null;
  /** Null while the thread has no binding: every workspace folder is then in its scope. */
  readonly publishScope: (scope: ThreadFolderScope | null) => void;
  /** Asks the scope's thread to add a workspace folder; ignored with no scope. */
  readonly requestAdd: (folder: Omit<ThreadFolderAddRequest, 'threadId'>) => void;
  readonly reset: () => void;
  readonly scope: ThreadFolderScope | null;
}

export const useThreadFolderScopeStore = create<ThreadFolderScopeState>((set, get) => ({
  consumeAdd: (threadId) => {
    const { pendingAdd } = get();
    if (!pendingAdd || pendingAdd.threadId !== threadId) {
      return null;
    }
    // Cleared BEFORE the caller's async write, so a re-render cannot apply it twice.
    set({ pendingAdd: null });
    return pendingAdd;
  },
  pendingAdd: null,
  publishScope: (scope) => {
    set({ scope });
  },
  requestAdd: (folder) => {
    const { scope } = get();
    if (scope) {
      set({ pendingAdd: { ...folder, threadId: scope.threadId } });
    }
  },
  reset: () => set({ pendingAdd: null, scope: null }),
  scope: null,
}));
