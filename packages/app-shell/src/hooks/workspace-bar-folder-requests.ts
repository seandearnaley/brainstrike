import type { WorkspaceBarRoot } from '@brainstrike/assistant-ui';
import type { FolderRequests } from '@brainstrike/file-explorer-hooks';

/**
 * A closed thread folder with its reopen in flight, or the reason the last one failed, so the chip
 * says what the folder's file tabs say. Every other folder is returned as it is.
 */
export function withFolderRequest<T extends WorkspaceBarRoot>(
  root: T,
  requests: FolderRequests
): T {
  if (!(root.removed && root.path)) {
    return root;
  }
  if (requests.opening.has(root.path)) {
    return { ...root, reopening: true };
  }
  const failure = requests.failures.get(root.path);
  return failure === undefined ? root : { ...root, reopenFailure: failure };
}
