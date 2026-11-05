import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
  isAbsolutePath,
  type TargetOf,
} from '@brainstrike/context-actions';
import type { ChangedFileEntry } from '@brainstrike/types';
import { Copy, ExternalLink, FolderOpen, FolderPlus } from 'lucide-react';

type ChangedFileTarget = TargetOf<'changed-file'>;
type WorktreeTarget = TargetOf<'worktree'>;

/**
 * The target a right-click on a changed file claims, from its tree row or its
 * diff header alike. `rootPathById` resolves the file's root for an entry no
 * worktree resolved.
 */
export function changedFileTarget(
  entry: ChangedFileEntry,
  rootPathById: ReadonlyMap<string, string>
): ChangedFileTarget {
  return {
    kind: 'changed-file',
    patch: entry.patch,
    path: entry.path,
    repositoryRoot: entry.repositoryRoot,
    rootId: entry.rootId,
    rootPath: entry.rootId === null ? null : (rootPathById.get(entry.rootId) ?? null),
    worktreePath: entry.worktreePath,
  };
}

/**
 * Joins a worktree-relative `path` onto its absolute `worktreePath`, matching
 * separator style with the worktree path (mirrors the separator detection in
 * `@brainstrike/context-actions`'s `toRelativePath`). Returns null when the
 * worktree root itself is unknown — callers must not guess an absolute path.
 */
function resolveAbsolutePath(worktreePath: string | null, path: string): string | null {
  if (worktreePath === null) {
    return null;
  }
  if (isAbsolutePath(path)) {
    return path;
  }
  const separator = worktreePath.includes('\\') ? '\\' : '/';
  const base = worktreePath.endsWith(separator) ? worktreePath : `${worktreePath}${separator}`;
  return `${base}${path}`;
}

/**
 * `worktreePath` wins when known (it is the more precise base — a
 * journal-sourced entry never has one). `rootPath` is the fallback for those
 * entries: the entry's relative `path` is root-relative, not worktree-
 * relative, when no worktree resolved it.
 */
function resolveChangedFileAbsolutePath(target: ChangedFileTarget): string | null {
  return resolveAbsolutePath(target.worktreePath ?? target.rootPath, target.path);
}

async function copyText(
  services: ActionServices,
  text: string,
  copied: string
): Promise<ActionOutcome> {
  if (!services.clipboard) {
    return { error: 'Clipboard service unavailable', ok: false };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { message: copied, ok: true } : outcome;
}

const copyChangedFileRelativePath: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'copy',
  icon: Copy,
  id: 'changes.copy-relative-path',
  label: 'Copy Relative Path',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyText(services, target.path, 'Relative path copied'),
};

const copyChangedFileFullPath: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'copy',
  icon: Copy,
  id: 'changes.copy-full-path',
  isVisible: (target) => resolveChangedFileAbsolutePath(target) !== null,
  label: 'Copy Full Path',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => {
    const absolutePath = resolveChangedFileAbsolutePath(target);
    if (absolutePath === null) {
      return Promise.resolve({ error: 'No absolute path available for this file', ok: false });
    }
    return copyText(services, absolutePath, 'Full path copied');
  },
};

const copyChangedFilePatch: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'copy',
  icon: Copy,
  id: 'changes.copy-patch',
  isVisible: (target) => target.patch !== null,
  label: 'Copy Patch',
  requiredCapabilities: ['clipboard'],
  run: (target, services) => {
    if (target.patch === null) {
      return Promise.resolve({ error: 'This view holds no patch for this file', ok: false });
    }
    return copyText(services, target.patch, 'Patch copied');
  },
};

const openChangedFile: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'navigate',
  icon: ExternalLink,
  id: 'changes.open-file',
  isVisible: (target) => resolveChangedFileAbsolutePath(target) !== null,
  label: 'Open File',
  requiredCapabilities: ['fs.openPath'],
  run: async (target: ChangedFileTarget, services: ActionServices): Promise<ActionOutcome> => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    const absolutePath = resolveChangedFileAbsolutePath(target);
    if (absolutePath === null) {
      return { error: 'No absolute path available for this file', ok: false };
    }
    return await services.platformFs.openPath(absolutePath);
  },
};

const revealChangedFile: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'navigate',
  icon: FolderOpen,
  id: 'changes.reveal-file',
  isVisible: (target) => resolveChangedFileAbsolutePath(target) !== null,
  label: 'Reveal in Explorer',
  requiredCapabilities: ['fs.reveal'],
  run: async (target: ChangedFileTarget, services: ActionServices): Promise<ActionOutcome> => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    const absolutePath = resolveChangedFileAbsolutePath(target);
    if (absolutePath === null) {
      return { error: 'No absolute path available for this file', ok: false };
    }
    return await services.platformFs.showItemInFolder(absolutePath);
  },
};

const openWorktree: ContextAction<'worktree'> = {
  appliesTo: ['worktree'],
  group: 'navigate',
  icon: ExternalLink,
  id: 'changes.open-worktree',
  label: 'Open in…',
  requiredCapabilities: ['fs.openPath'],
  run: async (target: WorktreeTarget, services: ActionServices): Promise<ActionOutcome> => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    return await services.platformFs.openPath(target.path);
  },
};

/**
 * Unlock path for an out-of-root worktree: the Changes surface can SHOW a
 * worktree outside every granted workspace root, but its files stay
 * unopenable until the user grants that root. Adding a root with a specific
 * pre-filled path requires a native directory-picker gesture
 * (`addRootDirectory` from `useFileExplorerContext`/`useFileSystem`) that is
 * only reachable from React context inside the Explorer tree — not from a
 * plain `ActionServices` seam, and not with a caller-supplied path (the
 * picker always resolves to whatever the user selects, never an
 * action-supplied target, which is deliberate: silently granting filesystem
 * access to an arbitrary path without an explicit OS-level user gesture
 * would be exactly the kind of implicit consent this codebase's context
 * action rules forbid). Wiring that up is new plumbing outside this task's
 * file list, so this action takes the honest smaller step instead: switch to
 * the Explorer tab, where the existing "Add Folder" control lives, and tell
 * the user what to click next.
 */
const addWorktreeAsRoot: ContextAction<'worktree'> = {
  appliesTo: ['worktree'],
  group: 'navigate',
  icon: FolderPlus,
  id: 'changes.add-worktree-as-root',
  isVisible: (target) => target.containment === 'outside-roots',
  label: 'Add as Workspace Root',
  run: (_target: WorktreeTarget): Promise<ActionOutcome> => {
    usePanelLayoutStore.getState().setActiveTab('explorer');
    return Promise.resolve({
      message: 'Opened Explorer — click "Add Folder" to grant access to this worktree',
      ok: true,
    });
  },
};

export const openChangedFileAction = defineContextAction(openChangedFile);
export const revealChangedFileAction = defineContextAction(revealChangedFile);
export const openWorktreeAction = defineContextAction(openWorktree);
export const addWorktreeAsRootAction = defineContextAction(addWorktreeAsRoot);
export const copyChangedFileRelativePathAction = defineContextAction(copyChangedFileRelativePath);
export const copyChangedFileFullPathAction = defineContextAction(copyChangedFileFullPath);
export const copyChangedFilePatchAction = defineContextAction(copyChangedFilePatch);

export const changesActions: readonly AnyContextAction[] = [
  openChangedFileAction,
  revealChangedFileAction,
  copyChangedFileRelativePathAction,
  copyChangedFileFullPathAction,
  copyChangedFilePatchAction,
  openWorktreeAction,
  addWorktreeAsRootAction,
];
