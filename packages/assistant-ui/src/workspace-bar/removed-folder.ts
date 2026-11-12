import type { WorkspaceBarRoot } from './workspace-bar';

/**
 * What a folder the workspace no longer serves is doing, in the words the file tabs use: opening
 * again, closed, or unable to open (with the host's reason). A folder with no path left no row.
 */
export function removedFolderState(root: WorkspaceBarRoot): string {
  if (root.reopening) {
    return 'Opening…';
  }
  if (!root.path) {
    return 'No longer exists';
  }
  return root.reopenFailure ? "Can't be opened" : 'Closed';
}

/**
 * Where a removed folder stands. The fixed wording opens a sentence in the menu and sits
 * lowercase inside the where-control's accessible name; the host's reason is never recased.
 */
export function removedFolderLabel(root: WorkspaceBarRoot, inline = false): string {
  const state = removedFolderState(root);
  const words = inline ? state.toLowerCase() : state;
  const reason = root.path && !root.reopening ? root.reopenFailure : undefined;
  return reason ? `${words}: ${reason}` : words;
}
