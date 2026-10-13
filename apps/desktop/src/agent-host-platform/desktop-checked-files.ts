/**
 * BST-1990 PR 3: a run's checked files, placed by the thread's binding. Checked
 * files reach the model from every thread folder, whichever folder is focused.
 * A file checked in a live workspace folder outside the thread is attached for
 * this run only: the run may read exactly the checked files of the folders
 * named in `attachedRootIds`, and no folder is granted to the thread.
 */
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';

type RuntimeWorkspaceRoot = NonNullable<RuntimeData['workspaceRoots']>[number];
type RuntimeWorkspaceContext = NonNullable<RuntimeData['workspaceContext']>;

export interface DesktopCheckedFiles {
  /** Live workspace folders outside the thread that have checked files. */
  readonly attachedRootIds: readonly string[];
  /** The run's checked files, each path relative to its folder. */
  readonly workspaceContext?: RuntimeWorkspaceContext;
}

/**
 * A checked file's path within its folder. The desktop explorer reports
 * absolute paths; the read tools address a file relative to its folder. A path
 * outside its own folder is kept as sent, and the read's containment refuses it.
 */
function folderPath(filePath: string, root: RuntimeWorkspaceRoot | undefined): string {
  if (!(root && path.isAbsolute(filePath))) {
    return filePath;
  }
  const relative = path.relative(root.path, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return `/${relative.split(path.sep).join('/')}`;
}

export function placeCheckedFiles(
  context: RuntimeWorkspaceContext | undefined,
  threadRoots: readonly RuntimeWorkspaceRoot[],
  liveRoots: readonly RuntimeWorkspaceRoot[]
): DesktopCheckedFiles {
  if (!context) {
    return { attachedRootIds: [] };
  }
  const attached = new Set<string>();
  const files = (context.files ?? []).map((file) => {
    const inThread = threadRoots.find((root) => root.rootId === file.rootId);
    const live = inThread ? undefined : liveRoots.find((root) => root.rootId === file.rootId);
    if (live) {
      attached.add(live.rootId);
    }
    return { ...file, path: folderPath(file.path, inThread ?? live) };
  });
  return { attachedRootIds: [...attached], workspaceContext: { ...context, files } };
}
