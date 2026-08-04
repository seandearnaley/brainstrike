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
import { ExternalLink, FolderOpen, FolderPlus } from 'lucide-react';

type ChangedFileTarget = TargetOf<'changed-file'>;
type WorktreeTarget = TargetOf<'worktree'>;

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

const openChangedFile: ContextAction<'changed-file'> = {
  appliesTo: ['changed-file'],
  group: 'navigate',
  icon: ExternalLink,
  id: 'changes.open-file',
  isVisible: (target) => resolveAbsolutePath(target.worktreePath, target.path) !== null,
  label: 'Open File',
  requiredCapabilities: ['fs.openPath'],
  run: async (target: ChangedFileTarget, services: ActionServices): Promise<ActionOutcome> => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    const absolutePath = resolveAbsolutePath(target.worktreePath, target.path);
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
  isVisible: (target) => resolveAbsolutePath(target.worktreePath, target.path) !== null,
  label: 'Reveal in Explorer',
  requiredCapabilities: ['fs.reveal'],
  run: async (target: ChangedFileTarget, services: ActionServices): Promise<ActionOutcome> => {
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    const absolutePath = resolveAbsolutePath(target.worktreePath, target.path);
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

export const changesActions: readonly AnyContextAction[] = [
  openChangedFileAction,
  revealChangedFileAction,
  openWorktreeAction,
  addWorktreeAsRootAction,
];
